import { assign, setup } from 'xstate';
import type { SimParams } from '../sim/params';

export interface FitLoopInput {
  /** Stop as converged once a scored run's RMS is at or below this. */
  readonly rmsThreshold: number;
  /** Stop after this many simulate-and-score iterations whatever the RMS. */
  readonly maxIterations: number;
}

export type FitMode = 'agent' | 'numericOnly';

export interface FitLoopContext extends FitLoopInput {
  /** Who proposes parameters: the Muse Spark agent, or only the numeric optimiser after an agent failure. */
  readonly mode: FitMode;
  /** Completed simulate-and-score iterations. */
  readonly iteration: number;
  readonly current: SimParams | null;
  readonly lastRms: number | null;
  readonly best: { readonly params: SimParams; readonly rms: number } | null;
  readonly agentError: string | null;
  /** Agent explanations, one per proposal that carried one, for the UI log. */
  readonly log: readonly string[];
  readonly stopReason: 'converged' | 'maxIter' | null;
}

export type FitLoopEvent =
  | { type: 'START'; initial: SimParams }
  | { type: 'PROPOSAL'; params: SimParams; note?: string }
  | { type: 'AGENT_FAILED'; error: string }
  | { type: 'SIM_DONE' }
  | { type: 'SCORED'; rms: number };

export interface FitLoopOutput {
  readonly params: SimParams | null;
  readonly rms: number | null;
  readonly iterations: number;
  readonly mode: FitMode;
  readonly reason: 'converged' | 'maxIter';
}

const nextIteration = ({ context }: { context: FitLoopContext }) => context.iteration + 1;

/**
 * FitLoop, spec §6.2: propose parameters, simulate, score against the SAM
 * tracks, repeat until the RMS is good enough or the iteration budget is
 * spent. If the agent fails, the loop falls back to numeric-only proposals and
 * keeps going.
 */
export const fitLoopMachine = setup({
  types: {
    context: {} as FitLoopContext,
    events: {} as FitLoopEvent,
    input: {} as FitLoopInput,
    output: {} as FitLoopOutput,
  },
  guards: {
    withinThreshold: ({ context, event }) =>
      event.type === 'SCORED' && Number.isFinite(event.rms) && event.rms <= context.rmsThreshold,
    budgetSpent: ({ context }) => nextIteration({ context }) >= context.maxIterations,
    numericOnly: ({ context }) => context.mode === 'numericOnly',
  },
  actions: {
    recordScore: assign(({ context, event }) => {
      if (event.type !== 'SCORED' || !context.current) return {};
      const rms = Number.isFinite(event.rms) ? event.rms : Number.POSITIVE_INFINITY;
      const improved = !context.best || rms < context.best.rms;
      return {
        iteration: nextIteration({ context }),
        lastRms: rms,
        best: improved ? { params: context.current, rms } : context.best,
      };
    }),
    takeProposal: assign(({ context, event }) => {
      if (event.type !== 'PROPOSAL') return {};
      return {
        current: event.params,
        log: event.note ? [...context.log, event.note] : context.log,
      };
    }),
  },
}).createMachine({
  id: 'fitLoop',
  initial: 'idle',
  context: ({ input }) => ({
    ...input,
    mode: 'agent',
    iteration: 0,
    current: null,
    lastRms: null,
    best: null,
    agentError: null,
    log: [],
    stopReason: null,
  }),
  states: {
    idle: {
      on: {
        START: { target: 'proposing', actions: assign({ current: ({ event }) => event.initial }) },
      },
    },
    proposing: {
      on: {
        PROPOSAL: { target: 'simulating', actions: 'takeProposal' },
        AGENT_FAILED: { target: 'agentError', actions: assign({ agentError: ({ event }) => event.error }) },
      },
    },
    agentError: {
      entry: assign({ mode: 'numericOnly' }),
      always: 'numericOnly',
    },
    numericOnly: {
      on: {
        PROPOSAL: { target: 'simulating', actions: 'takeProposal' },
      },
    },
    simulating: {
      on: { SIM_DONE: 'scoring' },
    },
    scoring: {
      on: {
        SCORED: [
          { guard: 'withinThreshold', target: 'converged', actions: 'recordScore' },
          { guard: 'budgetSpent', target: 'maxIter', actions: 'recordScore' },
          { guard: 'numericOnly', target: 'numericOnly', actions: 'recordScore' },
          { target: 'proposing', actions: 'recordScore' },
        ],
      },
    },
    converged: { type: 'final', entry: assign({ stopReason: 'converged' }) },
    maxIter: { type: 'final', entry: assign({ stopReason: 'maxIter' }) },
  },
  output: ({ context }) => ({
    params: context.best?.params ?? null,
    rms: context.best?.rms ?? null,
    iterations: context.iteration,
    mode: context.mode,
    reason: context.stopReason ?? 'maxIter',
  }),
});

export const FIT_LOOP_STATES = [
  'idle',
  'proposing',
  'agentError',
  'numericOnly',
  'simulating',
  'scoring',
  'converged',
  'maxIter',
] as const;
export type FitLoopState = (typeof FIT_LOOP_STATES)[number];
