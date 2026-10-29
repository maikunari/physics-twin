import { beforeAll, describe, expect, it } from 'vitest';
import { FIXTURE_IMAGE_SIZE, FIXTURE_SCENE } from '../scene/fixtures';
import { DEFAULT_SIM_PARAMS } from '../sim/params';
import { initRapier } from '../sim/sceneWorld';
import { makeSyntheticTake } from '../synthetic/syntheticTake';
import { detectReleaseTime } from './release';
import { parseSamText } from './samText';
import { tracksToTrajectories, type TrajectoryPoint } from './trajectories';

beforeAll(async () => {
  await initRapier();
});

const ballPoints = (releaseDelaySec: number, seed: number, pixelNoise: number) => {
  const take = makeSyntheticTake(FIXTURE_SCENE, FIXTURE_IMAGE_SIZE, DEFAULT_SIM_PARAMS, {
    durationSec: 0.6,
    releaseDelaySec,
    seed,
    pixelNoise,
    dropRate: 0.05,
    lowConfidenceRate: 0.03,
  });
  expect(take.releaseFrame).toBe(Math.round(releaseDelaySec * 240));
  return tracksToTrajectories(parseSamText(take.samText).records, take.objects, take.calibration)[0]!.points;
};

describe('detectReleaseTime', () => {
  it.each([
    [1, 1],
    [0.8, 2],
    [1.25, 3],
  ])('finds a release %f s into a noisy take to within two frames', (delay, seed) => {
    const t0 = detectReleaseTime(ballPoints(delay, seed, 0.7));
    expect(t0).not.toBeNull();
    // Seen: 2–5 ms early, partly because the fixture ball starts a hair above the ramp and drops onto it.
    expect(Math.abs(t0! - delay)).toBeLessThan(2 / 240);
  });

  it('finds a release at the very first frame', () => {
    expect(detectReleaseTime(ballPoints(0, 4, 0.7))).toBeCloseTo(0, 2);
  });

  it('returns null when the ball never moves or there are no points', () => {
    const still: TrajectoryPoint[] = Array.from({ length: 50 }, (_, i) => ({
      frame: i,
      t: i / 240,
      x: 10 + 0.05 * Math.sin(i),
      y: 20,
      px: { x: 0, y: 0 },
      confidence: 0.9,
    }));
    expect(detectReleaseTime(still)).toBeNull();
    expect(detectReleaseTime([])).toBeNull();
  });
});
