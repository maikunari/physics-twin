import { describe, expect, it } from 'vitest';
import { createActor } from 'xstate';
import { FIT_LOOP_STATES, fitLoopMachine, type FitLoopContext, type FitLoopEvent, type FitLoopState } from './fitLoop';
import { DEFAULT_SIM_PARAMS, type SimParams } from '../sim/params';

const input = { rmsThreshold: 0.004, maxIterations: 10 };
const P = DEFAULT_SIM_PARAMS;

const baseContext: FitLoopContext = {
  ...input,
  mode: 'agent',
  iteration: 0,
  current: P,
  lastRms: null,
  best: null,
  agentError: null,
  log: [],
  stopReason: null,
};

function actorIn(state: FitLoopState, context: Partial<FitLoopContext> = {}) {
  const snapshot = fitLoopMachine.resolveState({ value: state, context: { ...baseContext, ...context } });
  return createActor(fitLoopMachine, { input, snapshot }).start();
}

const ev = {
  START: { type: 'START', initial: P },
  PROPOSAL: { type: 'PROPOSAL', params: { ...P, restitution: 0.6 }, note: 'bounce too low on segment 3, raising e' },
  AGENT_FAILED: { type: 'AGENT_FAILED', error: 'tool call timed out' },
  SIM_DONE: { type: 'SIM_DONE' },
  SCORED_GOOD: { type: 'SCORED', rms: 0.003 },
  SCORED_POOR: { type: 'SCORED', rms: 0.02 },
} satisfies Record<string, FitLoopEvent>;

describe('FitLoop transitions', () => {
  it.each([
    ['idle', ev.START, {}, 'proposing'],
    ['proposing', ev.PROPOSAL, {}, 'simulating'],
    ['proposing', ev.AGENT_FAILED, {}, 'numericOnly'],
    ['numericOnly', ev.PROPOSAL, { mode: 'numericOnly' }, 'simulating'],
    ['simulating', ev.SIM_DONE, {}, 'scoring'],
    ['scoring', ev.SCORED_GOOD, {}, 'converged'],
    ['scoring', ev.SCORED_POOR, {}, 'proposing'],
    ['scoring', ev.SCORED_POOR, { mode: 'numericOnly' }, 'numericOnly'],
    ['scoring', ev.SCORED_POOR, { iteration: 9 }, 'maxIter'],
  ] as const)('%s --%j--> (context %j) %s', (from, event, context, to) => {
    const actor = actorIn(from, context);
    actor.send(event);
    expect(actor.getSnapshot().value).toBe(to);
  });

  it('passes through agentError, records the error and switches to numeric-only', () => {
    const actor = actorIn('proposing');
    actor.send(ev.AGENT_FAILED);
    const { value, context } = actor.getSnapshot();
    expect(value).toBe('numericOnly');
    expect(context.mode).toBe('numericOnly');
    expect(context.agentError).toBe('tool call timed out');
  });

  it('logs agent notes and keeps the best parameters seen', () => {
    const actor = createActor(fitLoopMachine, { input }).start();
    actor.send(ev.START);
    actor.send({ type: 'PROPOSAL', params: { ...P, muRamp: 0.1 }, note: 'first guess' });
    actor.send(ev.SIM_DONE);
    actor.send({ type: 'SCORED', rms: 0.01 });
    actor.send({ type: 'PROPOSAL', params: { ...P, muRamp: 0.9 } });
    actor.send(ev.SIM_DONE);
    actor.send({ type: 'SCORED', rms: 0.05 });
    const { context } = actor.getSnapshot();
    expect(context.iteration).toBe(2);
    expect(context.lastRms).toBe(0.05);
    expect(context.best).toEqual({ params: { ...P, muRamp: 0.1 }, rms: 0.01 });
    expect(context.log).toEqual(['first guess']);
  });

  it('treats a non-finite score as the worst possible, never as converged', () => {
    const actor = actorIn('scoring');
    actor.send({ type: 'SCORED', rms: Number.NaN });
    expect(actor.getSnapshot().value).toBe('proposing');
    expect(actor.getSnapshot().context.lastRms).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('FitLoop invalid events', () => {
  const allowed: Record<FitLoopState, FitLoopEvent['type'][]> = {
    idle: ['START'],
    proposing: ['PROPOSAL', 'AGENT_FAILED'],
    agentError: [],
    numericOnly: ['PROPOSAL'],
    simulating: ['SIM_DONE'],
    scoring: ['SCORED'],
    converged: [],
    maxIter: [],
  };
  const events = [ev.START, ev.PROPOSAL, ev.AGENT_FAILED, ev.SIM_DONE, ev.SCORED_GOOD];
  // agentError is transient (it always moves on to numericOnly), so it cannot rest to be tested.
  const cases = FIT_LOOP_STATES.filter((s) => s !== 'agentError').flatMap((state) =>
    events.filter((e) => !allowed[state].includes(e.type)).map((e) => [state, e.type, e] as const),
  );

  it.each(cases)('%s ignores %s', (state, _type, event) => {
    const actor = actorIn(state, state === 'numericOnly' ? { mode: 'numericOnly' } : {});
    const before = actor.getSnapshot();
    actor.send(event);
    expect(actor.getSnapshot().value).toBe(state);
    expect(actor.getSnapshot().context).toEqual(before.context);
  });

  it('numericOnly ignores a late agent failure', () => {
    const actor = actorIn('numericOnly', { mode: 'numericOnly', agentError: 'first' });
    actor.send({ type: 'AGENT_FAILED', error: 'second' });
    expect(actor.getSnapshot().context.agentError).toBe('first');
  });
});

/**
 * Drives the loop the way the app will: a proposer callback stands in for the
 * agent or the numeric optimiser, and a synthetic objective stands in for
 * simulate-and-score.
 */
function runLoop(opts: {
  maxIterations: number;
  rmsThreshold: number;
  propose: (best: SimParams, iteration: number) => SimParams | 'fail';
  score: (p: SimParams) => number;
}) {
  const actor = createActor(fitLoopMachine, {
    input: { maxIterations: opts.maxIterations, rmsThreshold: opts.rmsThreshold },
  }).start();
  actor.send({ type: 'START', initial: P });
  for (let guard = 0; guard < 10_000 && actor.getSnapshot().status === 'active'; guard++) {
    const { value, context } = actor.getSnapshot();
    if (value === 'proposing' || value === 'numericOnly') {
      const proposal = opts.propose(context.best?.params ?? context.current ?? P, context.iteration);
      if (proposal === 'fail') actor.send({ type: 'AGENT_FAILED', error: 'agent unavailable' });
      else actor.send({ type: 'PROPOSAL', params: proposal });
    } else if (value === 'simulating') {
      actor.send({ type: 'SIM_DONE' });
    } else if (value === 'scoring') {
      actor.send({ type: 'SCORED', rms: opts.score(actor.getSnapshot().context.current ?? P) });
    }
  }
  return actor.getSnapshot();
}

describe('FitLoop runs', () => {
  const target = 0.62;
  const score = (p: SimParams) => Math.abs(p.restitution - target);

  it('stops at max iterations when the RMS never gets good enough', () => {
    const snap = runLoop({ maxIterations: 7, rmsThreshold: 1e-9, propose: (b) => ({ ...b }), score: () => 0.5 });
    expect(snap.value).toBe('maxIter');
    expect(snap.status).toBe('done');
    expect(snap.output).toMatchObject({ iterations: 7, reason: 'maxIter', rms: 0.5 });
  });

  it('falls back to numeric-only after an agent failure and still converges', () => {
    let agentAnswers = 2;
    let step = 0.2;
    let direction = 1;
    let lastProposed: SimParams | null = null;
    // The agent answers twice, then fails once; a step-halving line search takes over.
    const propose = (best: SimParams): SimParams | 'fail' => {
      if (agentAnswers-- === 0) return 'fail';
      if (lastProposed && lastProposed !== best) {
        direction = -direction;
        step /= 2;
      }
      lastProposed = { ...best, restitution: best.restitution + direction * step };
      return lastProposed;
    };
    const snap = runLoop({ maxIterations: 60, rmsThreshold: 0.005, propose, score });
    expect(snap.value).toBe('converged');
    expect(snap.output?.mode).toBe('numericOnly');
    expect(snap.output?.reason).toBe('converged');
    expect(snap.output?.params?.restitution).toBeCloseTo(target, 2);
    expect(snap.context.agentError).toBe('agent unavailable');
  });
});
