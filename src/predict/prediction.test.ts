import { beforeAll, describe, expect, it } from 'vitest';
import { makeFitProblem } from '../fit/fitter';
import { initRapier } from '../sim/sceneWorld';
import { syntheticFitCase, syntheticTruth, type SyntheticFitCase } from '../synthetic/syntheticProblem';
import { commitPrediction } from './commitment';
import { ENSEMBLE_SIZE, cholesky, fitUncertainty, sampleEnsemble } from './ensemble';
import { makePrediction } from './prediction';

const TRUTH = syntheticTruth(0.08, 0.55);
/** The fit as if it had found the truth exactly: these tests are about what happens after the fit. */
const FIT = { params: TRUTH, timeShiftSec: 0, rmsCm: 0.086 };

let take: SyntheticFitCase;
beforeAll(async () => {
  await initRapier();
  take = syntheticFitCase(TRUTH, 1, 2.2);
});

describe('makePrediction', () => {
  it('runs 12 sampled futures and puts the nominal event inside their band', () => {
    const p = makePrediction(take.problem, FIT);
    expect(p.members).toHaveLength(ENSEMBLE_SIZE);
    expect(p.freezeSec).toBe(1);
    expect(p.horizonEndSec).toBe(2);
    expect(p.band.kind).toBe(p.nominal.event.kind);
    expect(p.nominal.event.t).toBeGreaterThan(p.freezeSec);
    expect(p.band.x[0]).toBeLessThanOrEqual(p.nominal.event.x);
    expect(p.band.x[1]).toBeGreaterThanOrEqual(p.nominal.event.x);
    expect(p.band.t[0]).toBeLessThanOrEqual(p.nominal.event.t);
    expect(p.band.t[1]).toBeGreaterThanOrEqual(p.nominal.event.t);
    // The paths cover the freeze to the horizon, for drawing and for the trajectory error.
    expect(p.nominal.path[0]!.t).toBeLessThanOrEqual(p.freezeSec);
    expect(p.nominal.path.at(-1)!.t).toBeGreaterThanOrEqual(p.horizonEndSec);
  });

  it('is deterministic: the same fit gives the same prediction', () => {
    expect(makePrediction(take.problem, FIT)).toEqual(makePrediction(take.problem, FIT));
  });

  it('never runs past the end of the clip, and refuses a clip that ends at the freeze', () => {
    expect(makePrediction(take.problem, FIT, { clipEndSec: 1.4 }).horizonEndSec).toBe(1.4);
    expect(() => makePrediction(take.problem, FIT, { clipEndSec: 1 })).toThrow(/nothing left to predict/);
  });

  it('no peeking: footage after the freeze changes neither the prediction nor its commitment', async () => {
    const garbled = take.points.map((p) => (p.t > 1 ? { ...p, x: p.x + 500, y: -p.y - 40 } : p));
    const a = makePrediction(makeFitProblem(take.take.world, take.points), FIT);
    const b = makePrediction(makeFitProblem(take.take.world, garbled), FIT);
    expect(b).toEqual(a);
    expect((await commitPrediction('A01', b)).hash).toBe((await commitPrediction('A01', a)).hash);
  });
});

describe('fit uncertainty and the ensemble', () => {
  it('gives every fitted parameter and the release a spread between its floor and cap', () => {
    const u = fitUncertainty(take.problem, FIT);
    expect(u.keys).toEqual(['muRamp', 'restitution', 'timeShiftSec']);
    expect(u.sigma[0]).toBeGreaterThanOrEqual(0.0005);
    expect(u.sigma[0]).toBeLessThanOrEqual(0.05);
    expect(u.sigma[1]).toBeGreaterThanOrEqual(0.005);
    expect(u.sigma[1]).toBeLessThanOrEqual(0.15);
    expect(u.sigma[2]).toBeGreaterThanOrEqual(0.0005);
    expect(u.residualRmsCm).toBeGreaterThan(0);
    expect(u.residualRmsCm).toBeLessThan(0.2);
  });

  it('samples runs around the fit from a fixed seed, within physical bounds', () => {
    const u = fitUncertainty(take.problem, FIT);
    const runs = sampleEnsemble(FIT, u);
    expect(runs).toEqual(sampleEnsemble(FIT, u));
    expect(sampleEnsemble(FIT, u, 12, 7)).not.toEqual(runs);
    const mus = runs.map((r) => r.params.muRamp);
    expect(new Set(mus).size).toBe(12);
    for (const r of runs) {
      expect(Math.abs(r.params.muRamp - TRUTH.muRamp)).toBeLessThan(6 * (u.sigma[0] ?? 0));
      expect(r.params.restitution).toBeGreaterThanOrEqual(0);
      expect(r.params.restitution).toBeLessThanOrEqual(0.95);
      // Only the fitted parameters vary.
      expect(r.params.muTable).toBe(TRUTH.muTable);
    }
  });

  it('cholesky factors a positive-definite matrix and rejects one that is not', () => {
    const a = [
      [4, 2],
      [2, 3],
    ];
    const l = cholesky(a)!;
    const back = [0, 1].map((i) => [0, 1].map((j) => (l[i]![0]! * l[j]![0]!) + (l[i]![1]! * l[j]![1]!)));
    expect(back[0]![0]).toBeCloseTo(4);
    expect(back[0]![1]).toBeCloseTo(2);
    expect(back[1]![1]).toBeCloseTo(3);
    expect(cholesky([[1, 2], [2, 1]])).toBeNull();
  });
});
