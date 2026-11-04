import { beforeAll, describe, expect, it } from 'vitest';
import { createFitAgent } from '../agent/fitAgent';
import type { SparkRequest, SparkTransport } from '../agent/sparkWire';
import { initRapier } from '../sim/sceneWorld';
import { syntheticFitCase, syntheticTruth } from '../synthetic/syntheticProblem';
import type { TrajectoryPoint } from '../tracks/trajectories';
import { makeFitProblem } from './fitter';
import { runFitSession, type Proposer } from './session';

/**
 * Day-3 fitter on the synthetic ground truth: the same takes and tolerance as
 * day 2's test (|Δμ_ramp| ≤ 0.002, |Δe| ≤ 0.05 on the 0–1.0 s window with
 * 0.7 px jitter, 5% lost frames and 3% wrong boxes), now through the FitLoop
 * machine with Nelder–Mead, with and without the agent.
 */
const TOLERANCE = { mu: 0.002, restitution: 0.05 };
/** Fitted parameters start far off; the held ones at their true values. */
const START = { muRamp: 0.3, restitution: 0.5 };
/** What the stand-in agent proposes, turn by turn: rough guesses in the right region, as a model would give. */
const GUESSES = [
  { muRamp: 0.1, restitution: 0.6 },
  { muRamp: 0.07, restitution: 0.5 },
  { muRamp: 0.09, restitution: 0.4 },
];

beforeAll(async () => {
  await initRapier();
});

/**
 * A stand-in Muse Spark: each turn, one simulate call with the next guess,
 * then propose it. Records every request.
 */
function scriptedModel(guesses: readonly { muRamp: number; restitution: number }[]) {
  const requests: SparkRequest[] = [];
  let turn = -1;
  const transport: SparkTransport = async (request) => {
    requests.push(structuredClone(request));
    const outputs = request.input.filter((i) => i.type === 'function_call_output').length;
    if (outputs === 0) turn++;
    const guess = guesses[turn % guesses.length];
    const params = { ...syntheticTruth(0, 0), muTable: 0.25, rollingDamping: 0.2, ...guess };
    const call =
      outputs === 0
        ? { name: 'simulate', arguments: JSON.stringify({ params }) }
        : { name: 'propose', arguments: JSON.stringify({ params, note: 'bounce too high in the bounce segment, lowering e' }) };
    return { output: [{ type: 'function_call', call_id: `call_${requests.length}`, ...call }] };
  };
  return { transport, requests };
}

describe('synthetic ground truth through the fit loop', () => {
  it.each([
    [0.08, 0.55, 1],
    [0.03, 0.45, 2],
    [0.12, 0.7, 3],
    [0.05, 0.3, 4],
  ])('numeric only: μ_ramp %f, e %f (noise seed %i)', async (muRamp, restitution, seed) => {
    const truth = syntheticTruth(muRamp, restitution);
    const { problem } = syntheticFitCase(truth, seed);
    const result = await runFitSession(problem, { ...truth, ...START });

    expect(result.loop.mode).toBe('numericOnly');
    expect(Math.abs(result.best.params.muRamp - muRamp)).toBeLessThanOrEqual(TOLERANCE.mu);
    expect(Math.abs(result.best.params.restitution - restitution)).toBeLessThanOrEqual(TOLERANCE.restitution);
    // Measurement noise leaves about 0.9 mm at the truth; day 2's bound of 2 mm leaves room for a nearby local minimum.
    expect(result.best.rmsCm).toBeLessThan(0.2);
    // Released at frame 0, so there is nothing to correct.
    expect(Math.abs(result.best.timeShiftSec)).toBeLessThan(0.0005);
    expect(result.loop.params).toEqual(result.best.params);
  }, 30_000);

  it('with the agent: logs its tool calls and note, stays in agent mode and recovers the truth', async () => {
    const truth = syntheticTruth(0.03, 0.45);
    const { problem } = syntheticFitCase(truth, 2);
    const model = scriptedModel(GUESSES);
    const result = await runFitSession(problem, { ...truth, ...START }, { agent: createFitAgent({ transport: model.transport }) });

    expect(result.loop.mode).toBe('agent');
    expect(Math.abs(result.best.params.muRamp - 0.03)).toBeLessThanOrEqual(TOLERANCE.mu);
    expect(Math.abs(result.best.params.restitution - 0.45)).toBeLessThanOrEqual(TOLERANCE.restitution);
    const kinds = result.log.map((l) => l.kind);
    expect(kinds).toContain('tool');
    expect(result.log).toContainEqual({ kind: 'agent', text: 'bounce too high in the bounce segment, lowering e' });
    expect(model.requests.length).toBe(2 * result.loop.iterations);
  }, 30_000);

  it('falls back to numeric-only when the agent fails and still converges', async () => {
    const truth = syntheticTruth(0.05, 0.3);
    const { problem } = syntheticFitCase(truth, 4);
    const failing: Proposer = async () => {
      throw new Error('Meta Model API timed out');
    };
    const result = await runFitSession(problem, { ...truth, ...START }, { agent: failing });

    expect(result.loop.mode).toBe('numericOnly');
    expect(result.loop.reason).toBe('converged');
    expect(Math.abs(result.best.params.muRamp - 0.05)).toBeLessThanOrEqual(TOLERANCE.mu);
    expect(Math.abs(result.best.params.restitution - 0.3)).toBeLessThanOrEqual(TOLERANCE.restitution);
    expect(result.log).toContainEqual({ kind: 'error', text: 'Agent failed (Meta Model API timed out); continuing with Nelder–Mead alone.' });
  }, 30_000);

  it('a model that only ever answers in text counts as an agent failure', async () => {
    const truth = syntheticTruth(0.08, 0.55);
    const { problem } = syntheticFitCase(truth, 1);
    const chatty: SparkTransport = async () => ({
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'I think e is about 0.5.' }] }],
    });
    const result = await runFitSession(problem, { ...truth, ...START }, { agent: createFitAgent({ transport: chatty }) });
    expect(result.loop.mode).toBe('numericOnly');
    expect(result.log.find((l) => l.kind === 'error')?.text).toMatch(/no proposal after \d+ model calls; last reply: I think e is about 0.5/);
  }, 30_000);

  it('stops at the iteration budget and keeps the best run', async () => {
    const truth = syntheticTruth(0.08, 0.55);
    const { problem } = syntheticFitCase(truth, 1);
    const result = await runFitSession(problem, { ...truth, ...START }, { rmsThreshold: 0, maxIterations: 3 });
    expect(result.loop.reason).toBe('maxIter');
    expect(result.loop.iterations).toBe(3);
    expect(result.history).toHaveLength(3);
    expect(result.best.rmsCm).toBe(Math.min(...result.history.map((h) => h.rmsCm)));
  }, 30_000);

  it('is deterministic', async () => {
    const truth = syntheticTruth(0.12, 0.7);
    const { problem } = syntheticFitCase(truth, 3);
    const a = await runFitSession(problem, { ...truth, ...START }, { maxIterations: 2, rmsThreshold: 0 });
    const b = await runFitSession(problem, { ...truth, ...START }, { maxIterations: 2, rmsThreshold: 0 });
    expect(b.best).toEqual(a.best);
    expect(b.log).toEqual(a.log);
  }, 30_000);
});

/**
 * "No peeking" (build plan, day 3): the fitter, and the agent through it,
 * never see a measurement after the freeze time. Every point after 1.0 s is
 * replaced by a wildly wrong one; the fit, its log, and every byte sent to
 * the model must stay the same.
 */
describe('no peeking past the fit window', () => {
  const truth = syntheticTruth(0.08, 0.55);
  let take: ReturnType<typeof syntheticFitCase>['take'];
  let points: readonly TrajectoryPoint[];
  beforeAll(() => {
    ({ take, points } = syntheticFitCase(truth, 1));
  });
  const poison = (ps: readonly TrajectoryPoint[]) =>
    ps.map((p) => (p.t > 1 ? { ...p, x: p.x + 50, y: p.y + 50, px: { x: 0, y: 0 } } : p));

  it('the fit problem holds nothing after the window', () => {
    expect(points.some((p) => p.t > 1)).toBe(true);
    const problem = makeFitProblem(take.world, points);
    expect(problem.points.every((p) => p.t <= 1)).toBe(true);
    expect(Object.values(problem.segments).flat().every((p) => p.t <= 1)).toBe(true);
    expect(makeFitProblem(take.world, poison(points))).toEqual(problem);
  });

  it('the fit and everything the agent is sent are identical with poisoned future frames', async () => {
    const run = async (ps: readonly TrajectoryPoint[]) => {
      const model = scriptedModel(GUESSES);
      const result = await runFitSession(makeFitProblem(take.world, ps), { ...truth, ...START }, {
        agent: createFitAgent({ transport: model.transport }),
        maxIterations: 2,
        rmsThreshold: 0,
      });
      return { result, requests: model.requests };
    };
    const honest = await run(points);
    const poisoned = await run(poison(points));
    expect(poisoned.result.best).toEqual(honest.result.best);
    expect(poisoned.result.log).toEqual(honest.result.log);
    expect(JSON.stringify(poisoned.requests)).toBe(JSON.stringify(honest.requests));
  }, 30_000);

  it('a shorter window reads less: the fit changes when the window does', async () => {
    const short = makeFitProblem(take.world, points, { windowEndSec: 0.6 });
    expect(short.points.every((p) => p.t <= 0.6)).toBe(true);
    expect(short.points.length).toBeLessThan(makeFitProblem(take.world, points).points.length);
  });
});
