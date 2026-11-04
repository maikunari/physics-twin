import { describe, expect, it } from 'vitest';
import type { FitEvaluation } from '../fit/fitter';
import type { FitLogEntry, ProposalContext } from '../fit/session';
import { DEFAULT_SIM_PARAMS, type SimParams } from '../sim/params';
import { AGENT_TOOLS, MAX_SIMULATE_CALLS, createFitAgent, simulateResultSchema, toolResult } from './fitAgent';
import { fetchTransport, sparkRequestSchema, type SparkRequest, type SparkTransport } from './sparkWire';

const P: SimParams = { ...DEFAULT_SIM_PARAMS, muRamp: 0.1, restitution: 0.6 };

const evaluation = (params: SimParams): FitEvaluation => ({
  params,
  timeShiftSec: 0,
  rmsCm: Math.abs(params.restitution - 0.55) + 0.1,
  segments: {
    ramp: { points: 90, rmsCm: 0.08, meanOffsetCm: { x: -0.01, y: 0 }, maxCm: 0.2 },
    flight: { points: 8, rmsCm: 0.1, meanOffsetCm: { x: 0.02, y: 0.01 }, maxCm: 0.15 },
    bounce: { points: 110, rmsCm: 0.6, meanOffsetCm: { x: 0.1, y: 0.4 }, maxCm: 1.3 },
    roll: null,
  },
});

function contextStub() {
  const log: FitLogEntry[] = [];
  const simulated: SimParams[] = [];
  const context: ProposalContext = {
    iteration: 0,
    best: evaluation(P),
    history: [],
    windowEndSec: 1,
    simulate: (params) => {
      simulated.push(params);
      return evaluation(params);
    },
    log: (e) => log.push(e),
  };
  return { context, log, simulated };
}

type Call = { name: string; args: unknown } | { text: string };

/** A model that answers each request with the next scripted call, recording what it was sent. */
function scripted(calls: readonly Call[]) {
  const requests: SparkRequest[] = [];
  const transport: SparkTransport = async (request) => {
    requests.push(structuredClone(request));
    const next = calls[requests.length - 1];
    if (!next) throw new Error('script ran out');
    if ('text' in next) return { output: [{ type: 'message', content: [{ type: 'output_text', text: next.text }] }] };
    return {
      output: [
        { type: 'reasoning', summary: [] },
        {
          type: 'function_call',
          call_id: `c${requests.length}`,
          name: next.name,
          arguments: typeof next.args === 'string' ? next.args : JSON.stringify(next.args),
        },
      ],
    };
  };
  return { transport, requests };
}

const outputs = (request: SparkRequest | undefined) =>
  (request?.input ?? []).flatMap((i) => (i.type === 'function_call_output' ? [JSON.parse(i.output) as Record<string, unknown>] : []));

describe('fitting agent tools', () => {
  it('declares strict JSON schemas: every parameter required, nothing extra', () => {
    for (const tool of AGENT_TOOLS) {
      expect(tool.strict).toBe(true);
      expect(tool.parameters).toMatchObject({ type: 'object', additionalProperties: false });
      expect(tool.parameters).not.toHaveProperty('$schema');
    }
    const simulate = AGENT_TOOLS.find((t) => t.name === 'simulate');
    const params = (simulate?.parameters.properties as Record<string, { required?: string[] }>).params;
    expect(params?.required?.sort()).toEqual(Object.keys(DEFAULT_SIM_PARAMS).sort());
  });

  it('validates its own simulate result before sending it', () => {
    expect(simulateResultSchema.safeParse(toolResult(evaluation(P))).success).toBe(true);
    expect(toolResult(evaluation(P)).segments.roll).toBeNull();
  });
});

describe('fitting agent turn', () => {
  it('simulates, then returns the proposal and note; every request is in the allowed shape', async () => {
    const model = scripted([
      { name: 'simulate', args: { params: { ...P, restitution: 0.5 } } },
      { name: 'propose', args: { params: { ...P, restitution: 0.52 }, note: 'bounce too high, lowering e' } },
    ]);
    const { context, log, simulated } = contextStub();
    const proposal = await createFitAgent({ transport: model.transport })(context);

    expect(proposal).toEqual({ params: { ...P, restitution: 0.52 }, note: 'bounce too high, lowering e' });
    expect(simulated).toEqual([{ ...P, restitution: 0.5 }]);
    expect(log).toEqual([{ kind: 'tool', text: 'simulate(μ ramp 0.1, e 0.5) → RMS 1.50 mm' }]);
    for (const r of model.requests) expect(sparkRequestSchema.safeParse(r).success).toBe(true);
    // The second request carries the first call and its validated result.
    const [result] = outputs(model.requests[1]);
    expect(simulateResultSchema.safeParse(result).success).toBe(true);
    expect(model.requests[0]?.input[0]).toMatchObject({ type: 'message', role: 'user' });
    expect(String((model.requests[0]?.input[0] as { content: string }).content)).toContain('"bounce"');
  });

  it('sends invalid arguments back to the model as an error instead of simulating them', async () => {
    const model = scripted([
      { name: 'simulate', args: { params: { ...P, restitution: 1.5 } } },
      { name: 'simulate', args: '{not json' },
      { name: 'propose', args: { params: { ...P, muRamp: -1 }, note: 'x' } },
      { name: 'propose', args: { params: P, note: 'back to the best run' } },
    ]);
    const { context, log, simulated } = contextStub();
    const proposal = await createFitAgent({ transport: model.transport })(context);

    expect(simulated).toEqual([]);
    expect(proposal.params).toEqual(P);
    expect(outputs(model.requests[3]).map((o) => o.error)).toEqual(['invalid arguments', 'invalid arguments', 'invalid arguments']);
    expect(log.map((l) => l.kind)).toEqual(['error', 'error', 'error']);
  });

  it(`allows ${MAX_SIMULATE_CALLS} simulate calls per turn, then insists on propose`, async () => {
    const sim = { name: 'simulate', args: { params: P } };
    const model = scripted([sim, sim, sim, sim, { name: 'propose', args: { params: P, note: 'done' } }]);
    const { context, simulated } = contextStub();
    await createFitAgent({ transport: model.transport })(context);
    expect(simulated).toHaveLength(MAX_SIMULATE_CALLS);
    expect(outputs(model.requests[4]).at(-1)?.error).toMatch(/budget/);
  });

  it('answers an unknown tool with an error', async () => {
    const model = scripted([{ name: 'set_gravity', args: {} }, { name: 'propose', args: { params: P, note: 'ok' } }]);
    const { context } = contextStub();
    await createFitAgent({ transport: model.transport })(context);
    expect(outputs(model.requests[1])[0]?.error).toMatch(/unknown tool set_gravity/);
  });

  it('fails the turn when the model never proposes', async () => {
    const sim = { name: 'simulate', args: { params: P } };
    const model = scripted(Array.from({ length: 10 }, () => sim));
    const { context } = contextStub();
    await expect(createFitAgent({ transport: model.transport })(context)).rejects.toThrow(/no proposal after 5 model calls/);
  });

  it('fails the turn on a reply that is not a Responses API reply', async () => {
    const { context } = contextStub();
    await expect(createFitAgent({ transport: async () => ({ error: 'quota' }) })(context)).rejects.toThrow(/not a Responses API reply/);
  });

  it('asks again for a tool call after a text-only reply, and fails the turn if none comes', async () => {
    const { context } = contextStub();
    const script = scripted([{ text: 'Lowering the bounce.' }, { name: 'propose', args: { params: P, note: 'lower e' } }]);
    await expect(createFitAgent({ transport: script.transport })(context)).resolves.toMatchObject({ note: 'lower e' });
    expect(script.requests[1]?.input.slice(-2)).toEqual([
      { type: 'message', role: 'assistant', content: 'Lowering the bounce.' },
      { type: 'message', role: 'user', content: 'Answer with a tool call: simulate to test, or propose.' },
    ]);
    const silent = Array.from({ length: MAX_SIMULATE_CALLS + 2 }, () => ({ text: '' }));
    await expect(createFitAgent({ transport: scripted(silent).transport })(context)).rejects.toThrow(/no proposal after/);
  });
});

describe('fetchTransport', () => {
  const request = sparkRequestSchema.parse({
    model: 'muse-spark-1.3',
    instructions: 'i',
    input: [{ type: 'message', role: 'user', content: 'hi' }],
    tools: AGENT_TOOLS,
    tool_choice: 'auto',
    parallel_tool_calls: false,
  });

  it('posts the request as JSON and returns the reply', async () => {
    let sent: { url: string; body: unknown } | null = null;
    const fake = (async (url: string, init: RequestInit) => {
      sent = { url, body: JSON.parse(String(init.body)) };
      return new Response(JSON.stringify({ output: [] }), { status: 200 });
    }) as typeof fetch;
    await expect(fetchTransport('/api/agent', fake)(request)).resolves.toEqual({ output: [] });
    expect(sent).toEqual({ url: '/api/agent', body: request });
  });

  it('throws on an error status, with the reason', async () => {
    const fake = (async () => new Response('MODEL_API_KEY is not set', { status: 503 })) as typeof fetch;
    await expect(fetchTransport('/api/agent', fake)(request)).rejects.toThrow(/503: MODEL_API_KEY is not set/);
  });
});
