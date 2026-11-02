import { z } from 'zod';
import { PARAM_BOUNDS, type FitEvaluation } from '../fit/fitter';
import { SEGMENT_NAMES } from '../fit/segments';
import type { Proposal, ProposalContext, Proposer } from '../fit/session';
import type { SimParams } from '../sim/params';
import {
  SPARK_AGENT_MODEL,
  functionCalls,
  outputText,
  sparkResponseSchema,
  type InputItem,
  type SparkRequest,
  type SparkTransport,
} from './sparkWire';

const bounded = (key: keyof SimParams) => z.number().min(PARAM_BOUNDS[key][0]).max(PARAM_BOUNDS[key][1]);

/** Parameters as the agent writes them: every one, inside its physical range. */
export const agentParamsSchema = z.strictObject({
  muRamp: bounded('muRamp'),
  muTable: bounded('muTable'),
  restitution: bounded('restitution'),
  rollingDamping: bounded('rollingDamping'),
  v0: bounded('v0'),
  omega0: bounded('omega0'),
});

export const simulateArgsSchema = z.strictObject({ params: agentParamsSchema });

export const proposeArgsSchema = z.strictObject({
  params: agentParamsSchema,
  /** One or two sentences for the UI log: what the agent saw and what it changed. */
  note: z.string().min(1).max(400),
});

const segmentErrorSchema = z.strictObject({
  points: z.number().int().nonnegative(),
  rmsCm: z.number(),
  meanOffsetCm: z.strictObject({ x: z.number(), y: z.number() }),
  maxCm: z.number(),
});

/** What the `simulate` tool returns to the model. Validated before it is sent, like the model's arguments. */
export const simulateResultSchema = z.strictObject({
  params: agentParamsSchema,
  rmsCm: z.number(),
  segments: z.strictObject({
    ramp: segmentErrorSchema.nullable(),
    flight: segmentErrorSchema.nullable(),
    bounce: segmentErrorSchema.nullable(),
    roll: segmentErrorSchema.nullable(),
  }),
});
export type SimulateResult = z.infer<typeof simulateResultSchema>;

const round = (v: number, digits = 4) => Number(v.toFixed(digits));

export function toolResult(evaluation: FitEvaluation): SimulateResult {
  const segments = Object.fromEntries(
    SEGMENT_NAMES.map((name) => {
      const s = evaluation.segments[name];
      return [
        name,
        s && {
          points: s.points,
          rmsCm: round(s.rmsCm),
          meanOffsetCm: { x: round(s.meanOffsetCm.x), y: round(s.meanOffsetCm.y) },
          maxCm: round(s.maxCm),
        },
      ];
    }),
  );
  return simulateResultSchema.parse({
    params: Object.fromEntries(Object.entries(evaluation.params).map(([k, v]) => [k, round(v, 5)])),
    rmsCm: round(evaluation.rmsCm),
    segments,
  });
}

function jsonSchemaFor(schema: z.ZodType): Record<string, unknown> {
  const json = { ...(z.toJSONSchema(schema, { target: 'draft-7' }) as Record<string, unknown>) };
  delete json.$schema;
  return json;
}

export const AGENT_TOOLS: SparkRequest['tools'] = [
  {
    type: 'function',
    name: 'simulate',
    description:
      'Run the 2D physics simulation of the scene with these parameters and score it against the measured ball path on the fit window. Returns the RMS distance and, per segment (ramp, flight, bounce, roll), the RMS, the mean offset of the simulated ball from the measured one and the largest miss, all in cm.',
    parameters: jsonSchemaFor(simulateArgsSchema),
    strict: true,
  },
  {
    type: 'function',
    name: 'propose',
    description:
      'Finish this turn with the parameters to hand to the numeric optimiser, and a one- or two-sentence note for the log saying what you saw in the segment errors and what you changed.',
    parameters: jsonSchemaFor(proposeArgsSchema),
    strict: true,
  },
];

export const AGENT_INSTRUCTIONS = `You are the fitting agent of Physics Twin. A phone filmed a ball rolling down a ramp, leaving its end and landing on a table. A 2D rigid-body simulation of the same scene must match the measured path of the ball over the fit window (the first part of the clip after release; you never see anything after it).

Parameters (all required on every call):
- muRamp: friction between ball and ramp. Only matters while the ball slips; a ball that rolls without slipping is not affected by a larger value.
- muTable: friction on the table and blocks.
- restitution: bounce, 0 to 0.95, used for every contact after the ramp.
- rollingDamping: angular damping standing in for rolling loss, 1/s.
- v0: initial speed down the ramp, cm/s. The simulation starts at the detected release, so this is normally 0.
- omega0: initial spin, rad/s. Normally 0.

The world frame is in centimetres: x to the right along the table, y up from the table line. Segment errors: ramp (on the ramp), flight (in the air after leaving it), bounce (from the first touch until it stays down), roll (on the table). meanOffsetCm is simulated minus measured: x > 0 means the simulated ball is ahead of the real one, y > 0 means it is higher. A segment the ball did not reach inside the window is null.

How to work: read the errors, form a hypothesis (for example "the simulated ball is behind on the ramp, so the ramp friction is too high" or "the bounce is too high, lower restitution"), test it with simulate (at most 3 calls per turn), then call propose. A numeric optimiser fine-tunes muRamp and restitution from your proposal, so aim for the right region rather than the last digit. Change parameters only for a reason you can state, and keep the note short and concrete.`;

/** At most this many `simulate` calls per turn, then the agent must propose. */
export const MAX_SIMULATE_CALLS = 3;
/** Model calls per turn before the turn counts as failed. */
const MAX_ROUNDS = MAX_SIMULATE_CALLS + 2;

const fmtCm = (v: number) => `${(v * 10).toFixed(2)} mm`;

function describeEvaluation(e: FitEvaluation): string {
  return JSON.stringify(toolResult(e));
}

function turnPrompt(context: ProposalContext): string {
  const history = context.history.map((h, i) => `${i + 1}: RMS ${fmtCm(h.rmsCm)}`).join('; ');
  return [
    `Turn ${context.iteration + 1}. Fit window: ${context.windowEndSec} s after release.`,
    `Best run so far: ${describeEvaluation(context.best)}`,
    history ? `Scored iterations so far (after numeric fine tuning): ${history}.` : 'No iterations scored yet.',
    'Simulate to test your hypothesis, then propose.',
  ].join('\n');
}

export interface FitAgentOptions {
  readonly transport: SparkTransport;
}

/**
 * The Muse Spark fitting agent (spec §4) as a FitLoop proposer. Each turn
 * is a short tool-calling conversation: the model reads the best run's
 * per-segment error, may call `simulate` a few times, and ends with
 * `propose`. Every tool argument and result goes through zod; an invalid
 * argument is returned to the model as an error, a turn that never
 * proposes throws, which the fit loop treats as an agent failure.
 *
 * The model only ever sees the scores the fit problem produces, so it
 * cannot read past the fit window either.
 */
export function createFitAgent({ transport }: FitAgentOptions): Proposer {
  return async (context): Promise<Proposal> => {
    const input: InputItem[] = [{ type: 'message', role: 'user', content: turnPrompt(context) }];
    let simulateCalls = 0;
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const request: SparkRequest = {
        model: SPARK_AGENT_MODEL,
        instructions: AGENT_INSTRUCTIONS,
        input,
        tools: AGENT_TOOLS,
        tool_choice: 'required',
        parallel_tool_calls: false,
      };
      const parsed = sparkResponseSchema.safeParse(await transport(request));
      if (!parsed.success) throw new Error('Muse Spark reply is not a Responses API reply');
      const calls = functionCalls(parsed.data);
      if (calls.length === 0) {
        const text = outputText(parsed.data).trim();
        throw new Error(text ? `Muse Spark answered without a tool call: ${text.slice(0, 120)}` : 'Muse Spark answered nothing');
      }

      for (const call of calls) {
        input.push({ type: 'function_call', call_id: call.call_id, name: call.name, arguments: call.arguments });
        let args: unknown;
        try {
          args = JSON.parse(call.arguments);
        } catch {
          args = undefined;
        }

        if (call.name === 'propose') {
          const proposal = proposeArgsSchema.safeParse(args);
          if (proposal.success) return { params: proposal.data.params, note: proposal.data.note };
          context.log({ kind: 'error', text: `Agent proposal rejected: ${proposal.error.issues[0]?.message ?? 'invalid'}` });
          input.push({ type: 'function_call_output', call_id: call.call_id, output: errorOutput(proposal.error) });
          continue;
        }

        if (call.name === 'simulate') {
          const sim = simulateArgsSchema.safeParse(args);
          if (!sim.success) {
            context.log({ kind: 'error', text: `simulate call rejected: ${sim.error.issues[0]?.message ?? 'invalid'}` });
            input.push({ type: 'function_call_output', call_id: call.call_id, output: errorOutput(sim.error) });
            continue;
          }
          if (simulateCalls >= MAX_SIMULATE_CALLS) {
            input.push({
              type: 'function_call_output',
              call_id: call.call_id,
              output: JSON.stringify({ error: `simulate budget of ${MAX_SIMULATE_CALLS} calls is spent; call propose now` }),
            });
            continue;
          }
          simulateCalls++;
          const result = toolResult(context.simulate(sim.data.params));
          context.log({
            kind: 'tool',
            text: `simulate(μ ramp ${sim.data.params.muRamp}, e ${sim.data.params.restitution}) → RMS ${fmtCm(result.rmsCm)}`,
          });
          input.push({ type: 'function_call_output', call_id: call.call_id, output: JSON.stringify(result) });
          continue;
        }

        input.push({
          type: 'function_call_output',
          call_id: call.call_id,
          output: JSON.stringify({ error: `unknown tool ${call.name}; use simulate or propose` }),
        });
      }
    }
    throw new Error(`no proposal after ${MAX_ROUNDS} model calls`);
  };
}

function errorOutput(error: z.ZodError): string {
  return JSON.stringify({
    error: 'invalid arguments',
    issues: error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
  });
}
