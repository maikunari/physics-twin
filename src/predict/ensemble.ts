import { DEFAULT_FREE_PARAMS, MAX_TIME_SHIFT_SEC, clampParams, simulateWindow, type FitProblem, type ParamKey } from '../fit/fitter';
import { sampleAt } from '../fit/score';
import type { SimParams } from '../sim/params';
import { createPrng, gaussian } from '../sim/prng';

/** Spec §5: the prediction is a band from 12 runs with parameters sampled within the fit's uncertainty. */
export const ENSEMBLE_SIZE = 12;
/** Fixed, so the same fit always gives the same ensemble (and the same commitment). */
export const ENSEMBLE_SEED = 20261031;

/** What the ensemble varies: the fitted parameters and the release-time correction. */
export type UncertainKey = ParamKey | 'timeShiftSec';

/**
 * Finite-difference steps for the Jacobian, wide enough to step over the
 * jagged spots where a tiny change moves a contact by one simulation step.
 */
const STEP: Readonly<Record<UncertainKey, number>> = {
  muRamp: 0.002,
  muTable: 0.01,
  restitution: 0.02,
  rollingDamping: 0.05,
  v0: 1,
  omega0: 1,
  timeShiftSec: 0.001,
};
/**
 * Smallest spread per parameter. The statistical spread of a 240 fps fit can
 * be far below anything physical (μ_ramp to 0.0001), which would draw twelve
 * identical ghosts; these keep the band honest about the resolution the fit
 * can claim: about a tenth of a step above.
 */
const SIGMA_FLOOR: Readonly<Record<UncertainKey, number>> = {
  muRamp: 0.0005,
  muTable: 0.002,
  restitution: 0.005,
  rollingDamping: 0.01,
  v0: 0.2,
  omega0: 0.2,
  timeShiftSec: 0.0005,
};
/** Largest spread per parameter: a parameter the window cannot pin down (no bounce in it, say) varies this much. */
const SIGMA_CAP: Readonly<Record<UncertainKey, number>> = {
  muRamp: 0.05,
  muTable: 0.1,
  restitution: 0.15,
  rollingDamping: 0.5,
  v0: 10,
  omega0: 10,
  timeShiftSec: 0.005,
};
/**
 * Residuals this close in time are not independent (a misfit lasts many
 * frames), so the covariance is inflated by the number of points in this
 * span. Without it, 240 points a second claim far more certainty than the
 * fit has.
 */
const CORRELATION_SEC = 0.05;

export interface FitUncertainty {
  readonly keys: readonly UncertainKey[];
  /** One standard deviation per key, after the floor and cap. */
  readonly sigma: readonly number[];
  /** Covariance matching `sigma`, rows and columns in `keys` order. */
  readonly covariance: readonly (readonly number[])[];
  /** RMS of the residuals at the fit, cm: the noise level the covariance is scaled by. */
  readonly residualRmsCm: number;
}

export interface FittedRun {
  readonly params: SimParams;
  readonly timeShiftSec: number;
}

const valueOf = (run: FittedRun, key: UncertainKey) => (key === 'timeShiftSec' ? run.timeShiftSec : run.params[key]);

function withValue(run: FittedRun, key: UncertainKey, value: number): FittedRun {
  if (key === 'timeShiftSec') return { ...run, timeShiftSec: value };
  return { ...run, params: { ...run.params, [key]: value } };
}

/** The window residuals (x and y per measured point) of one run, cm. */
function residuals(problem: FitProblem, run: FittedRun): number[] {
  const sim = simulateWindow(problem, clampParams(run.params));
  const out: number[] = [];
  for (const p of problem.points) {
    const s = sampleAt(sim, p.t - run.timeShiftSec);
    out.push(s.x - p.x, s.y - p.y);
  }
  return out;
}

/** Cholesky factor L (lower) of a symmetric positive-definite matrix, or null if it is not one. */
export function cholesky(a: readonly (readonly number[])[]): number[][] | null {
  const n = a.length;
  const l = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = a[i]?.[j] ?? 0;
      for (let k = 0; k < j; k++) sum -= (l[i]?.[k] ?? 0) * (l[j]?.[k] ?? 0);
      const row = l[i] as number[];
      if (i === j) {
        if (!(sum > 0)) return null;
        row[j] = Math.sqrt(sum);
      } else {
        row[j] = sum / (l[j]?.[j] ?? 1);
      }
    }
  }
  return l;
}

/** Inverse of a symmetric positive-definite matrix through its Cholesky factor, or null if it is singular. */
function invertSpd(a: readonly (readonly number[])[]): number[][] | null {
  const l = cholesky(a);
  if (!l) return null;
  const n = a.length;
  const inv = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (let col = 0; col < n; col++) {
    // Solve L y = e_col, then Lᵀ x = y.
    const y = new Array<number>(n).fill(0);
    for (let i = 0; i < n; i++) {
      let sum = i === col ? 1 : 0;
      for (let k = 0; k < i; k++) sum -= (l[i]?.[k] ?? 0) * (y[k] ?? 0);
      y[i] = sum / (l[i]?.[i] ?? 1);
    }
    for (let i = n - 1; i >= 0; i--) {
      let sum = y[i] ?? 0;
      for (let k = i + 1; k < n; k++) sum -= (l[k]?.[i] ?? 0) * (inv[k]?.[col] ?? 0);
      (inv[i] as number[])[col] = sum / (l[i]?.[i] ?? 1);
    }
  }
  return inv;
}

/**
 * How well the fit window pins down each free parameter and the release
 * correction: the Gauss–Newton covariance s²(JᵀJ)⁻¹ of the window fit, with
 * J the residuals' Jacobian by central differences, s² the residual variance
 * at the fit, inflated for correlated residuals (CORRELATION_SEC), then held
 * between a floor and a cap per parameter. Reads only `problem`, so only the
 * fit window.
 *
 * This is the fit's statistical uncertainty. It does not know how wrong the
 * model is (no air drag, rolling loss as damping); the reveal measures that.
 */
export function fitUncertainty(problem: FitProblem, fit: FittedRun, free: readonly ParamKey[] = DEFAULT_FREE_PARAMS): FitUncertainty {
  const keys: UncertainKey[] = [...free, 'timeShiftSec'];
  const base = residuals(problem, fit);
  const m = base.length;
  const residualRmsCm = Math.sqrt(base.reduce((s, r) => s + r * r, 0) / Math.max(1, m));

  const columns = keys.map((key) => {
    const h = STEP[key];
    const v = valueOf(fit, key);
    const plus = residuals(problem, withValue(fit, key, v + h));
    const minus = residuals(problem, withValue(fit, key, v - h));
    return plus.map((p, i) => (p - (minus[i] ?? 0)) / (2 * h));
  });
  const jtj = keys.map((_, i) => keys.map((__, j) => (columns[i] ?? []).reduce((s, a, r) => s + a * (columns[j]?.[r] ?? 0), 0)));

  const dof = Math.max(1, m - keys.length);
  const variance = base.reduce((s, r) => s + r * r, 0) / dof;
  const span = Math.max(problem.windowEndSec, 1e-6);
  const inflation = Math.max(1, problem.points.length / (span / CORRELATION_SEC));
  // A parameter with no effect on the window has a zero column; a ridge keeps the matrix invertible and its spread at the cap.
  const ridge = keys.map((k) => variance * inflation / SIGMA_CAP[k] ** 2);
  const inverse = invertSpd(jtj.map((row, i) => row.map((v, j) => (i === j ? v + (ridge[i] ?? 0) : v))));
  const raw = inverse
    ? inverse.map((row) => row.map((v) => v * variance * inflation))
    : keys.map((k, i) => keys.map((__, j) => (i === j ? SIGMA_CAP[k] ** 2 : 0)));

  // Hold each spread between its floor and cap, keeping the correlations.
  const rawSigma = keys.map((_, i) => Math.sqrt(Math.max(0, raw[i]?.[i] ?? 0)));
  const sigma = keys.map((k, i) => Math.min(SIGMA_CAP[k], Math.max(SIGMA_FLOOR[k], rawSigma[i] ?? 0)));
  const covariance = keys.map((_, i) =>
    keys.map((__, j) => {
      if (i === j) return (sigma[i] ?? 0) ** 2;
      const ri = rawSigma[i] ?? 0;
      const rj = rawSigma[j] ?? 0;
      const corr = ri > 0 && rj > 0 ? (raw[i]?.[j] ?? 0) / (ri * rj) : 0;
      return Math.max(-1, Math.min(1, corr)) * (sigma[i] ?? 0) * (sigma[j] ?? 0);
    }),
  );
  return { keys, sigma, covariance, residualRmsCm };
}

/**
 * Draws `count` runs from a normal distribution around the fit with the
 * uncertainty's covariance, from a fixed seed. Parameters are clamped to
 * their physical range and the release correction to its own.
 */
export function sampleEnsemble(fit: FittedRun, uncertainty: FitUncertainty, count = ENSEMBLE_SIZE, seed = ENSEMBLE_SEED): FittedRun[] {
  const n = uncertainty.keys.length;
  // A tiny jitter on the diagonal in case the floors made the matrix only semi-definite.
  const l =
    cholesky(uncertainty.covariance.map((row, i) => row.map((v, j) => (i === j ? v * (1 + 1e-9) + 1e-18 : v)))) ??
    uncertainty.sigma.map((s, i) => uncertainty.sigma.map((_, j) => (i === j ? s : 0)));
  const rand = createPrng(seed);
  return Array.from({ length: count }, () => {
    const z = Array.from({ length: n }, () => gaussian(rand));
    let run = fit;
    uncertainty.keys.forEach((key, i) => {
      const delta = (l[i] ?? []).reduce((s, v, k) => s + v * (z[k] ?? 0), 0);
      run = withValue(run, key, valueOf(fit, key) + delta);
    });
    return {
      params: clampParams(run.params),
      timeShiftSec: Math.min(MAX_TIME_SHIFT_SEC, Math.max(-MAX_TIME_SHIFT_SEC, run.timeShiftSec)),
    };
  });
}
