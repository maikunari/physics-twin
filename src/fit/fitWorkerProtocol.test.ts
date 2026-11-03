import { beforeAll, describe, expect, it } from 'vitest';
import type { SparkTransport } from '../agent/sparkWire';
import { initRapier } from '../sim/sceneWorld';
import { syntheticFitCase, syntheticTruth } from '../synthetic/syntheticProblem';
import { fitRequestFor, handleFitRequest, type FitWorkerMessage } from './fitWorkerProtocol';

const truth = syntheticTruth(0.08, 0.55);
const initial = { ...truth, muRamp: 0.3, restitution: 0.5 };
const noAgent: SparkTransport = async () => {
  throw new Error('the agent was not asked for');
};

beforeAll(async () => {
  await initRapier();
});

describe('fit worker protocol', () => {
  it('cuts the points at the window before posting, and survives structured cloning', () => {
    const { take, points } = syntheticFitCase(truth, 1);
    const request = fitRequestFor({ world: take.world, points, initial, useAgent: false });
    expect(points.some((p) => p.t > 1)).toBe(true);
    expect(request.points.length).toBeGreaterThan(0);
    expect(request.points.every((p) => p.t <= 1)).toBe(true);
    expect(structuredClone(request)).toEqual(request);
  });

  it('runs the fit and posts log lines, progress and the result in order', async () => {
    const { take, points } = syntheticFitCase(truth, 1);
    const messages: FitWorkerMessage[] = [];
    await handleFitRequest(fitRequestFor({ world: take.world, points, initial, useAgent: false }), (m) => messages.push(m), noAgent);

    const types = messages.map((m) => m.type);
    expect(types.at(-1)).toBe('done');
    expect(types).toContain('log');
    expect(types).toContain('progress');
    const done = messages.at(-1);
    if (done?.type !== 'done') throw new Error('no result');
    expect(Math.abs(done.result.best.params.muRamp - 0.08)).toBeLessThanOrEqual(0.002);
    expect(structuredClone(done.result)).toEqual(done.result);
  }, 30_000);

  it('uses the transport only when the agent is on, and falls back when it fails', async () => {
    const { take, points } = syntheticFitCase(truth, 1);
    let calls = 0;
    const down: SparkTransport = async () => {
      calls++;
      throw new Error('/api/agent answered 503');
    };
    const messages: FitWorkerMessage[] = [];
    await handleFitRequest(fitRequestFor({ world: take.world, points, initial, useAgent: true }), (m) => messages.push(m), down);
    expect(calls).toBe(1);
    const done = messages.at(-1);
    expect(done?.type === 'done' && done.result.loop.mode).toBe('numericOnly');
  }, 30_000);

  it('posts failed for a take it cannot fit', async () => {
    const { take, points } = syntheticFitCase(truth, 1);
    const messages: FitWorkerMessage[] = [];
    await handleFitRequest(fitRequestFor({ world: take.world, points: points.slice(0, 1), initial, useAgent: false }), (m) => messages.push(m), noAgent);
    expect(messages).toEqual([{ type: 'failed', message: 'need at least two measured points on the ramp' }]);
  });
});
