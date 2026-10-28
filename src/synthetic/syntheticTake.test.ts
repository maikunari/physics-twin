import { beforeAll, describe, expect, it } from 'vitest';
import { FIXTURE_IMAGE_SIZE, FIXTURE_SCENE } from '../scene/fixtures';
import { DEFAULT_SIM_PARAMS } from '../sim/params';
import { initRapier } from '../sim/sceneWorld';
import { parseSamText } from '../tracks/samText';
import { tracksToTrajectories } from '../tracks/trajectories';
import { makeSyntheticTake } from './syntheticTake';

beforeAll(async () => {
  await initRapier();
});

describe('makeSyntheticTake', () => {
  it('writes SAM output the parser reads cleanly, one line per frame, ball first then blocks', () => {
    const take = makeSyntheticTake(FIXTURE_SCENE, FIXTURE_IMAGE_SIZE, DEFAULT_SIM_PARAMS, { durationSec: 0.5 });
    const parsed = parseSamText(take.samText);
    expect(parsed.diagnostics).toEqual([]);
    expect(take.samText.split('\n').filter(Boolean)).toHaveLength(121);
    expect(take.objects.map((o) => [o.id, o.kind])).toEqual([
      ['1', 'ball'],
      ['2', 'block'],
    ]);
  });

  it('without noise, the tracks pipeline gives back the true path to within half a pixel', () => {
    const take = makeSyntheticTake(FIXTURE_SCENE, FIXTURE_IMAGE_SIZE, DEFAULT_SIM_PARAMS, { durationSec: 1 });
    const [ball, block] = tracksToTrajectories(parseSamText(take.samText).records, take.objects, take.calibration);
    expect(ball!.points).toHaveLength(241);
    const halfPixelCm = 0.5 / take.calibration.pixelsPerCm;
    ball!.points.forEach((p, i) => {
      const truth = take.truth.samples[i]!;
      expect(p.t).toBeCloseTo(truth.t, 9);
      expect(Math.abs(p.x - truth.x)).toBeLessThanOrEqual(halfPixelCm + 1e-9);
      expect(Math.abs(p.y - truth.y)).toBeLessThanOrEqual(halfPixelCm + 1e-9);
    });
    // The block does not move.
    const blockX = new Set(block!.points.map((p) => p.x));
    expect(blockX.size).toBe(1);
  });

  it('loses frames and reports wrong boxes at low confidence at about the requested rates', () => {
    const take = makeSyntheticTake(FIXTURE_SCENE, FIXTURE_IMAGE_SIZE, DEFAULT_SIM_PARAMS, {
      durationSec: 2,
      seed: 7,
      dropRate: 0.1,
      lowConfidenceRate: 0.05,
    });
    const [ball] = tracksToTrajectories(parseSamText(take.samText).records, take.objects, take.calibration);
    const frames = take.truth.samples.length;
    expect(ball!.missingFrames.length / frames).toBeGreaterThan(0.06);
    expect(ball!.missingFrames.length / frames).toBeLessThan(0.14);
    expect(ball!.lowConfidenceFrames.length / frames).toBeGreaterThan(0.02);
    expect(ball!.lowConfidenceFrames.length / frames).toBeLessThan(0.08);
    expect(ball!.points.length + ball!.missingFrames.length + ball!.lowConfidenceFrames.length).toBeLessThanOrEqual(frames);
  });

  it('replays exactly from a seed and differs between seeds', () => {
    const opts = { durationSec: 0.5, pixelNoise: 1, dropRate: 0.05 } as const;
    const a = makeSyntheticTake(FIXTURE_SCENE, FIXTURE_IMAGE_SIZE, DEFAULT_SIM_PARAMS, { ...opts, seed: 3 });
    const b = makeSyntheticTake(FIXTURE_SCENE, FIXTURE_IMAGE_SIZE, DEFAULT_SIM_PARAMS, { ...opts, seed: 3 });
    const c = makeSyntheticTake(FIXTURE_SCENE, FIXTURE_IMAGE_SIZE, DEFAULT_SIM_PARAMS, { ...opts, seed: 4 });
    expect(b.samText).toBe(a.samText);
    expect(c.samText).not.toBe(a.samText);
  });
});
