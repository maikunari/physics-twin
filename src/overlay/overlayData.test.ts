import { beforeAll, describe, expect, it } from 'vitest';
import { FIXTURE_IMAGE_SIZE, FIXTURE_SCENE } from '../scene/fixtures';
import { DEFAULT_SIM_PARAMS, type SimParams } from '../sim/params';
import { initRapier } from '../sim/sceneWorld';
import { handleFitRequest, type FitWorkerMessage } from '../fit/fitWorkerProtocol';
import { makeFitProblem } from '../fit/fitter';
import { runFitSession } from '../fit/session';
import { SYNTHETIC_MEASUREMENT, syntheticTruth } from '../synthetic/syntheticProblem';
import { makeSyntheticTake } from '../synthetic/syntheticTake';
import type { ObjectTrajectory } from '../tracks/trajectories';
import {
  ballTrajectory,
  fitRequestForOverlay,
  frameAtTime,
  ghostAt,
  loadOverlayData,
  trailUntil,
  withParams,
} from './overlayData';

const TRUTH: SimParams = { ...DEFAULT_SIM_PARAMS, muRamp: 0.08, muTable: 0.25, restitution: 0.55 };
const sceneJson = JSON.stringify({ source: 'fixture', imageSize: FIXTURE_IMAGE_SIZE, markerDistanceCm: 50, scene: FIXTURE_SCENE });

let take: ReturnType<typeof makeSyntheticTake>;
beforeAll(async () => {
  await initRapier();
  take = makeSyntheticTake(FIXTURE_SCENE, FIXTURE_IMAGE_SIZE, TRUTH, {
    durationSec: 1.5,
    releaseDelaySec: 1,
    seed: 11,
    pixelNoise: 0.7,
    dropRate: 0.05,
    lowConfidenceRate: 0.03,
  });
});

const load = (params: SimParams = TRUTH) => loadOverlayData({ sceneJson, samText: take.samText, fps: 240, params });

describe('loadOverlayData', () => {
  it('builds trajectories, masks, the release time and a simulation from scene.json and sam-raw.txt', () => {
    const data = load();
    expect(data.calibration.pixelsPerCm).toBeCloseTo(11.52);
    expect(data.trajectories.map((t) => t.object.label)).toEqual(['ball', 'blue block']);
    expect(ballTrajectory(data)!.points.length).toBeGreaterThan(500);
    expect(data.masks.get(0)?.map((m) => m.objectId)).toEqual(['1', '2']);
    expect(data.droppedRecords).toBe(0);
    expect(Math.abs(data.releaseSec - 1)).toBeLessThan(2 / 240);
    // Long enough to cover the take after the release.
    expect(data.sim.samples.at(-1)!.t).toBeGreaterThan(1.5);
  });

  it('says what is wrong with bad inputs', () => {
    expect(() => loadOverlayData({ sceneJson: '{', samText: take.samText, fps: 240, params: TRUTH })).toThrow(/not JSON/);
    expect(() => loadOverlayData({ sceneJson: '{"scene":{}}', samText: take.samText, fps: 240, params: TRUTH })).toThrow(
      /scene schema/,
    );
    expect(() => loadOverlayData({ sceneJson, samText: '', fps: 240, params: TRUTH })).toThrow(/no ball track/);
  });

  it('a marker distance override rescales the world', () => {
    const data = loadOverlayData({ sceneJson, samText: take.samText, fps: 240, params: TRUTH, markerDistanceCm: 100 });
    expect(data.calibration.pixelsPerCm).toBeCloseTo(5.76);
  });
});

describe('frameAtTime', () => {
  it('maps media time to the frame on screen', () => {
    expect(frameAtTime(0, 240)).toBe(0);
    expect(frameAtTime(1 / 240, 240)).toBe(1);
    expect(frameAtTime(1 / 240 - 1e-4, 240)).toBe(0);
    expect(frameAtTime(1, 240)).toBe(240);
    expect(frameAtTime(-0.5, 240)).toBe(0);
  });
});

describe('trailUntil', () => {
  const point = (frame: number) => ({ frame, t: frame / 240, x: 0, y: 0, px: { x: frame, y: 0 }, confidence: 0.9 });
  const trajectory: ObjectTrajectory = {
    object: { id: '1', kind: 'ball', label: 'ball' },
    fps: 240,
    points: [0, 1, 2, 3, 30, 31].map(point),
    lowConfidenceFrames: [],
    missingFrames: [],
  };

  it('stops at the current time and breaks where the tracker lost the ball', () => {
    expect(trailUntil(trajectory, 2 / 240)).toEqual([[{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }]]);
    expect(trailUntil(trajectory, 1).map((run) => run.length)).toEqual([4, 2]);
    expect(trailUntil(trajectory, -1)).toEqual([]);
  });
});

describe('ghostAt', () => {
  it('sits on the ball until the release, then rides on the real ball when the parameters are right', () => {
    const data = load();
    const start = ghostAt(data, 0.2);
    expect(start.path).toHaveLength(1);
    expect(Math.hypot(start.ball.x - take.ballPx[0]!.x, start.ball.y - take.ballPx[0]!.y)).toBeLessThan(1);
    expect(start.radiusPx).toBeCloseTo(19.2);

    // Within a release-detection error of a frame or two, the ghost is on the true ball in the picture.
    for (const after of [0.2, 0.45, 0.8]) {
      const t = 1 + after;
      const ghost = ghostAt(data, t);
      const real = take.ballPx[frameAtTime(t, 240)]!;
      expect(Math.hypot(ghost.ball.x - real.x, ghost.ball.y - real.y)).toBeLessThan(start.radiusPx / 2);
    }
  });

  it('marks where the path leaves the fit window', () => {
    const data = load();
    expect(ghostAt(data, data.releaseSec + 0.5).fittedPoints).toBe(ghostAt(data, data.releaseSec + 0.5).path.length);
    const late = ghostAt(data, data.releaseSec + 1.3);
    expect(late.fittedPoints).toBe(241);
    expect(data.sim.samples[late.fittedPoints - 1]!.t).toBeCloseTo(1, 6);
    expect(late.path.length).toBeGreaterThan(late.fittedPoints);
  });

  it('holds the last simulated position past the end of the run', () => {
    const data = load();
    const end = ghostAt(data, 99);
    expect(end.path).toHaveLength(data.sim.samples.length);
  });
});

describe('withParams and the fit request', () => {
  it('re-simulates over the same span for new parameters', () => {
    const data = load();
    const next = withParams(data, { ...TRUTH, restitution: 0.2 });
    expect(next.sim.samples).toHaveLength(data.sim.samples.length);
    expect(next.sim.samples.at(-1)).not.toEqual(data.sim.samples.at(-1));
    expect(next.trajectories).toBe(data.trajectories);
  });

  it('sends the fitter only the first second after the release, timed from the release', () => {
    const data = load();
    const request = fitRequestForOverlay(data, false);
    const ball = ballTrajectory(data)!;
    const shown = ball.points.filter((p) => p.t >= data.releaseSec && p.t <= data.releaseSec + 1);
    expect(request.points).toHaveLength(shown.length);
    expect(request.points.every((p) => p.t >= 0 && p.t <= 1)).toBe(true);
    // The clip runs 1.5 s past the release, so half a second of it is held back.
    expect(ball.points.some((p) => p.t > data.releaseSec + 1.2)).toBe(true);
  });

  it('fits in the worker from a wrong start and brings the ghost back onto the real ball, past the window too', async () => {
    const wrong = load({ ...TRUTH, muRamp: 0.3, restitution: 0.2 });
    // 1.4 s after the release: 0.4 s past what the fitter saw.
    const t = wrong.releaseSec + 1.4;
    const real = take.ballPx[frameAtTime(t, 240)]!;
    const before = ghostAt(wrong, t).ball;
    const messages: FitWorkerMessage[] = [];
    await handleFitRequest(fitRequestForOverlay(wrong, false), (m) => messages.push(m), async () => ({}));
    const done = messages.at(-1);
    if (done?.type !== 'done') throw new Error(`fit did not finish: ${JSON.stringify(done)}`);
    const after = ghostAt(withParams(wrong, done.result.best.params), t).ball;
    expect(Math.hypot(before.x - real.x, before.y - real.y)).toBeGreaterThan(40);
    expect(Math.hypot(after.x - real.x, after.y - real.y)).toBeLessThan(10);
    expect(done.result.best.rmsCm).toBeLessThan(0.2);
  }, 20_000);
});

/**
 * The overlay path detects the release from the track, to within a frame or
 * so, and a 2 ms error moves μ_ramp by about 0.007. The fit refines the
 * release on the ramp segment and holds it. Stated tolerance on this path:
 * the release to 0.5 ms, |Δμ_ramp| ≤ 0.003, |Δe| ≤ 0.05.
 */
describe('fitting a take with a detected release', () => {
  it.each([
    [0.08, 0.55, 11],
    [0.03, 0.45, 12],
    [0.12, 0.7, 13],
    [0.05, 0.3, 14],
  ])('μ_ramp %f, e %f (noise seed %i)', async (muRamp, restitution, seed) => {
    const truth = syntheticTruth(muRamp, restitution);
    const delayed = makeSyntheticTake(FIXTURE_SCENE, FIXTURE_IMAGE_SIZE, truth, {
      durationSec: 1.5,
      releaseDelaySec: 1,
      seed,
      ...SYNTHETIC_MEASUREMENT,
    });
    const data = loadOverlayData({ sceneJson, samText: delayed.samText, fps: 240, params: { ...truth, muRamp: 0.3, restitution: 0.5 } });
    const request = fitRequestForOverlay(data, false);
    const result = await runFitSession(makeFitProblem(request.world, request.points), request.initial);

    // A positive shift means the ball really left later than detected.
    expect(Math.abs(data.releaseSec + result.best.timeShiftSec - 1)).toBeLessThan(0.0005);
    expect(Math.abs(result.best.params.muRamp - muRamp)).toBeLessThanOrEqual(0.003);
    expect(Math.abs(result.best.params.restitution - restitution)).toBeLessThanOrEqual(0.05);
  }, 30_000);
});
