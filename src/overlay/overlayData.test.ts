import { beforeAll, describe, expect, it } from 'vitest';
import { FIXTURE_IMAGE_SIZE, FIXTURE_SCENE } from '../scene/fixtures';
import { DEFAULT_SIM_PARAMS, type SimParams } from '../sim/params';
import { initRapier } from '../sim/sceneWorld';
import { makeSyntheticTake } from '../synthetic/syntheticTake';
import type { ObjectTrajectory } from '../tracks/trajectories';
import {
  ballTrajectory,
  fitOverlay,
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

  it('holds the last simulated position past the end of the run', () => {
    const data = load();
    const end = ghostAt(data, 99);
    expect(end.path).toHaveLength(data.sim.samples.length);
  });
});

describe('withParams and fitOverlay', () => {
  it('re-simulates over the same span for new parameters', () => {
    const data = load();
    const next = withParams(data, { ...TRUTH, restitution: 0.2 });
    expect(next.sim.samples).toHaveLength(data.sim.samples.length);
    expect(next.sim.samples.at(-1)).not.toEqual(data.sim.samples.at(-1));
    expect(next.trajectories).toBe(data.trajectories);
  });

  it('fits from a wrong start and brings the ghost back onto the real ball', () => {
    const wrong = load({ ...TRUTH, muRamp: 0.3, restitution: 0.2 });
    const t = 1.8;
    const real = take.ballPx[frameAtTime(t, 240)]!;
    const before = ghostAt(wrong, t).ball;
    const { data, recovery } = fitOverlay(wrong);
    const after = ghostAt(data, t).ball;
    expect(Math.hypot(before.x - real.x, before.y - real.y)).toBeGreaterThan(40);
    expect(Math.hypot(after.x - real.x, after.y - real.y)).toBeLessThan(10);
    expect(recovery.rmsCm).toBeLessThan(0.5);
  }, 20_000);
});
