import { beforeAll, describe, expect, it } from 'vitest';
import { FIXTURE_IMAGE_SIZE, FIXTURE_SCENE } from '../scene/fixtures';
import { DEFAULT_SIM_PARAMS, type SimParams } from '../sim/params';
import { initRapier } from '../sim/sceneWorld';
import { makeSyntheticTake } from '../synthetic/syntheticTake';
import { parseSamText } from '../tracks/samText';
import { tracksToTrajectories, type TrajectoryPoint } from '../tracks/trajectories';
import { recoverMuAndRestitution } from './recover';

/**
 * Synthetic ground-truth test (build plan, day 2): simulate the fixture scene
 * with a known μ_ramp and e, film it as SAM 3.1 output with realistic
 * measurement faults, run it through the normal tracks pipeline, and check
 * the fit recovers both.
 *
 * Stated tolerance: |Δμ_ramp| ≤ 0.002 and |Δe| ≤ 0.05, on the 0–1.0 s fit
 * window with 0.7 px jitter, 5% lost frames and 3% low-confidence wrong boxes.
 * A scan of 6 truths × 5 noise seeds stayed within |Δμ| ≤ 0.0003, |Δe| ≤ 0.025;
 * e is hardest at low values, where the bounce is small.
 */
const TOLERANCE = { mu: 0.002, restitution: 0.05 };
const MEASUREMENT = { pixelNoise: 0.7, dropRate: 0.05, lowConfidenceRate: 0.03 } as const;
/** Held parameters at their true values, the fitted ones started far off. */
const START = { muRamp: 0.3, restitution: 0.5 };

function measure(truth: SimParams, seed: number) {
  const take = makeSyntheticTake(FIXTURE_SCENE, FIXTURE_IMAGE_SIZE, truth, { durationSec: 1.5, seed, ...MEASUREMENT });
  const [ball] = tracksToTrajectories(parseSamText(take.samText).records, take.objects, take.calibration);
  return { take, points: ball!.points };
}

const truthWith = (muRamp: number, restitution: number): SimParams => ({
  ...DEFAULT_SIM_PARAMS,
  muRamp,
  muTable: 0.25,
  restitution,
  rollingDamping: 0.2,
});

beforeAll(async () => {
  await initRapier();
});

describe('synthetic ground truth: recover μ_ramp and e', () => {
  it.each([
    [0.08, 0.55, 1],
    [0.03, 0.45, 2],
    [0.12, 0.7, 3],
    [0.05, 0.3, 4],
  ])('μ_ramp %f, e %f (noise seed %i)', (muRamp, restitution, seed) => {
    const truth = truthWith(muRamp, restitution);
    const { take, points } = measure(truth, seed);
    const fit = recoverMuAndRestitution(take.world, points, { base: { ...truth, ...START } });

    expect(Math.abs(fit.params.muRamp - muRamp)).toBeLessThanOrEqual(TOLERANCE.mu);
    expect(Math.abs(fit.params.restitution - restitution)).toBeLessThanOrEqual(TOLERANCE.restitution);
    expect(fit.muRampIdentifiable).toBe(true);
    // The residual is the measurement noise, not model error: well under 2 mm.
    expect(fit.rmsCm).toBeLessThan(0.2);
  }, 20_000);

  it('reports μ_ramp as a lower bound when the ball rolls without slipping, and still recovers e', () => {
    const truth = truthWith(0.3, 0.5);
    const { take, points } = measure(truth, 5);
    const fit = recoverMuAndRestitution(take.world, points, { base: { ...truth, muRamp: 0.05, restitution: 0.2 } });

    // tan θ ≈ 0.5625 on the fixture ramp; a solid ball rolls without slipping once μ ≥ 2/7 · tan θ.
    expect(fit.muRampRollingThreshold).toBeCloseTo((2 / 7) * 0.5625, 3);
    expect(fit.muRampIdentifiable).toBe(false);
    expect(fit.params.muRamp).toBeGreaterThanOrEqual(0.9 * fit.muRampRollingThreshold);
    expect(Math.abs(fit.params.restitution - 0.5)).toBeLessThanOrEqual(TOLERANCE.restitution);
  }, 20_000);

  it('reads nothing after the fit window', () => {
    const truth = truthWith(0.08, 0.55);
    const { take, points } = measure(truth, 1);
    const base = { ...truth, ...START };
    const honest = recoverMuAndRestitution(take.world, points, { base });
    // Wildly wrong "future" measurements must not move the fit.
    const poisoned: TrajectoryPoint[] = points.map((p) => (p.t > 1 ? { ...p, x: p.x + 50, y: p.y + 50 } : p));
    const fit = recoverMuAndRestitution(take.world, poisoned, { base });
    expect(fit.params).toEqual(honest.params);
  }, 20_000);

  it('refuses a path with no measured points on or after the ramp', () => {
    const truth = truthWith(0.08, 0.55);
    const { take, points } = measure(truth, 1);
    expect(() => recoverMuAndRestitution(take.world, points.slice(0, 1), { base: truth })).toThrow(/on the ramp/);
    expect(() => recoverMuAndRestitution(take.world, points, { base: truth, windowEndSec: 0.2 })).toThrow(/after the ramp/);
  });
});
