import { beforeAll, describe, expect, it } from 'vitest';
import { initRapier } from '../sim/sceneWorld';
import { syntheticFitCase, syntheticTruth, type SyntheticFitCase } from '../synthetic/syntheticProblem';
import { commitPrediction, type Commitment } from './commitment';
import type { PathPoint } from './events';
import { makePrediction, type Prediction } from './prediction';
import { scoreReveal } from './reveal';

const TRUTH = syntheticTruth(0.08, 0.55);
const FPS = 240;

let take: SyntheticFitCase;
let prediction: Prediction;
let commitment: Commitment;
let pixelsPerCm: number;
beforeAll(async () => {
  await initRapier();
  take = syntheticFitCase(TRUTH, 1, 2.2);
  prediction = makePrediction(take.problem, { params: TRUTH, timeShiftSec: 0, rmsCm: 0.086 });
  commitment = await commitPrediction('A01', prediction);
  pixelsPerCm = take.take.calibration.pixelsPerCm;
});

const score = (measured: readonly PathPoint[]) =>
  scoreReveal({ prediction, commitment, measured, world: take.take.world, pixelsPerCm, fps: FPS });

/** The noise-free truth as a measured track: what the prediction should match exactly. */
const truthTrack = () => take.take.truth.samples.map((s) => ({ t: s.t, x: s.x, y: s.y }));

describe('scoreReveal', () => {
  it('scores a perfect prediction at zero error, inside the band', () => {
    const o = score(truthTrack());
    expect(o.commitmentHash).toBe(commitment.hash);
    expect(o.event.real?.kind).toBe(prediction.nominal.event.kind);
    expect(o.event.errorCm).toBeCloseTo(0, 6);
    expect(o.event.errorMs).toBeCloseTo(0, 6);
    expect(o.event.insideBand).toBe(true);
    expect(o.trajectory.rmsMm).toBeLessThan(0.01);
    expect(o.trajectory.points).toBeGreaterThan(200);
    expect(o.end.errorCm).toBeCloseTo(0, 6);
  });

  it('reports a shifted reality in cm, px and ms', () => {
    // Reality 3 cm further along and 20 ms later after the freeze.
    const track = truthTrack();
    const shifted = track.map((p) => (p.t > prediction.freezeSec ? { t: p.t + 0.02, x: p.x + 3, y: p.y } : p));
    const o = score(shifted);
    expect(o.event.errorCm).toBeCloseTo(3, 1);
    expect(o.event.errorPx).toBeCloseTo(3 * pixelsPerCm, 0);
    expect(o.event.errorMs).toBeCloseTo(20, 0);
    expect(o.event.insideBandX).toBe(false);
    expect(o.event.insideBand).toBe(false);
    expect(o.trajectory.rmsMm).toBeGreaterThan(25);
    expect(o.trajectory.rmsPx).toBeCloseTo(((o.trajectory.rmsMm ?? 0) / 10) * pixelsPerCm, 6);
  });

  it('says so when the predicted event never happened, and counts it as outside the band', () => {
    // The tracker lost the ball at the freeze.
    const o = score(truthTrack().filter((p) => p.t <= prediction.freezeSec));
    expect(o.event.real).toBeNull();
    expect(o.event.errorCm).toBeNull();
    expect(o.event.errorMs).toBeNull();
    expect(o.event.insideBand).toBe(false);
    expect(o.end.real).toBeNull();
    expect(o.trajectory).toEqual({ points: 0, rmsMm: null, rmsPx: null });
  });

  it('gives a horizon event no time error', async () => {
    // On this take the ball neither lands nor turns before the horizon.
    const slow = syntheticFitCase(syntheticTruth(0.03, 0.45), 2, 2.2);
    const p = makePrediction(slow.problem, { params: syntheticTruth(0.03, 0.45), timeShiftSec: 0, rmsCm: 0.086 });
    expect(p.nominal.event.kind).toBe('horizon');
    const o = scoreReveal({
      prediction: p,
      commitment: await commitPrediction('A02', p),
      measured: slow.take.truth.samples.map((s) => ({ t: s.t, x: s.x, y: s.y })),
      world: slow.take.world,
      pixelsPerCm,
      fps: FPS,
    });
    expect(o.event.errorCm).toBeCloseTo(0, 6);
    expect(o.event.errorMs).toBeNull();
    expect(o.event.insideBandT).toBeNull();
    expect(o.event.insideBand).toBe(true);
  });

  it('scores the synthetic take measured through SAM within a few millimetres', () => {
    const o = score(take.points);
    expect(o.event.real).not.toBeNull();
    expect(o.event.errorCm).toBeLessThan(0.5);
    expect(Math.abs(o.event.errorMs ?? Infinity)).toBeLessThan(5);
  });
});
