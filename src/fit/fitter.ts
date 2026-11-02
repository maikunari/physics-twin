import type { WorldScene } from '../scene/calibration';
import { BALL_INERTIA_FACTOR, type BallKind, type SimParams } from '../sim/params';
import { DEFAULT_DT, simulateScene, type Trajectory } from '../sim/sceneWorld';
import type { TrajectoryPoint } from '../tracks/trajectories';
import { nelderMead } from './nelderMead';
import { DEFAULT_WINDOW_END_SEC } from './recover';
import { rmsCm, withinWindow } from './score';
import { segmentReport, splitSegments, type MeasuredSegments, type SegmentReport } from './segments';

export type ParamKey = keyof SimParams;

/** Physical range of every parameter. Proposals outside it are clamped, never simulated as given. */
export const PARAM_BOUNDS: Readonly<Record<ParamKey, readonly [number, number]>> = {
  muRamp: [0.005, 1],
  muTable: [0.005, 1],
  restitution: [0, 0.95],
  rollingDamping: [0, 5],
  v0: [0, 200],
  omega0: [-200, 200],
};

/** Nelder–Mead's first step per parameter, about a tenth of its useful range. */
const INITIAL_STEP: Readonly<Record<ParamKey, number>> = {
  muRamp: 0.02,
  muTable: 0.05,
  restitution: 0.1,
  rollingDamping: 0.3,
  v0: 5,
  omega0: 5,
};

/**
 * Fitted by default: μ_ramp sets the ramp segment, e every contact after it.
 * μ_table and rolling damping barely move the first second, v0 and ω0 are zero
 * by construction (the simulation starts at the detected release), so they are
 * held unless a caller frees them.
 */
export const DEFAULT_FREE_PARAMS: readonly ParamKey[] = ['muRamp', 'restitution'];

/** Extra restitution starts for the whole-window stage of `polish`. */
const RESTITUTION_SPREAD = [0.25, 0.75] as const;

export function clampParams(params: SimParams): SimParams {
  const out = { ...params };
  for (const key of Object.keys(PARAM_BOUNDS) as ParamKey[]) {
    const [lo, hi] = PARAM_BOUNDS[key];
    const v = Number.isFinite(out[key]) ? out[key] : lo;
    out[key] = Math.min(hi, Math.max(lo, v));
  }
  return out;
}

/**
 * Everything the fitter is allowed to know about a take: the scene and the
 * measured ball path up to the end of the fit window. The window is applied
 * here, so nothing built from a FitProblem can read a later point.
 */
export interface FitProblem {
  readonly world: WorldScene;
  readonly windowEndSec: number;
  /** Measured ball points, t from the release, all at or before windowEndSec. */
  readonly points: readonly TrajectoryPoint[];
  readonly segments: MeasuredSegments;
  readonly ballKind?: BallKind;
}

export function makeFitProblem(
  world: WorldScene,
  points: readonly TrajectoryPoint[],
  options: { readonly windowEndSec?: number; readonly ballKind?: BallKind } = {},
): FitProblem {
  const windowEndSec = options.windowEndSec ?? DEFAULT_WINDOW_END_SEC;
  const visible = withinWindow(points, windowEndSec);
  const segments = splitSegments(visible, world);
  if (segments.ramp.length < 2) throw new Error('need at least two measured points on the ramp');
  return {
    world,
    windowEndSec,
    points: visible,
    segments,
    ...(options.ballKind ? { ballKind: options.ballKind } : {}),
  };
}

/**
 * Largest correction to the detected release time the fit may make, s. The
 * release detector is good to a frame or two at 240 fps, and 2 ms early
 * moves μ_ramp by about 0.007, so the fit refines it rather than trusting it.
 */
export const MAX_TIME_SHIFT_SEC = 0.02;
/** The release search stops once the shift is known to this, s: a tenth of a 240 fps frame. */
const RELEASE_SHIFT_RESOLUTION_SEC = 0.0002;

export interface FitEvaluation {
  /** The parameters actually simulated, after clamping. */
  readonly params: SimParams;
  /** Correction to the release time: measured t is compared with the simulation at t − shift. */
  readonly timeShiftSec: number;
  readonly rmsCm: number;
  readonly segments: SegmentReport;
}

const clampShift = (v: number) => Math.min(MAX_TIME_SHIFT_SEC, Math.max(-MAX_TIME_SHIFT_SEC, Number.isFinite(v) ? v : 0));

/**
 * The simulation over the fit window, plus the largest time shift and one
 * step, so a shifted comparison at the window's end still lands on a sample.
 */
export function simulateWindow(problem: FitProblem, params: SimParams, untilSec = problem.windowEndSec): Trajectory {
  return simulateScene(problem.world, params, {
    durationSec: untilSec + MAX_TIME_SHIFT_SEC + DEFAULT_DT,
    ...(problem.ballKind ? { ballKind: problem.ballKind } : {}),
  });
}

/** One `simulate` call: the run for these parameters scored against the window, in total and per segment. */
export function evaluateParams(problem: FitProblem, proposed: SimParams, timeShiftSec = 0): FitEvaluation {
  const params = clampParams(proposed);
  const shift = clampShift(timeShiftSec);
  const sim = simulateWindow(problem, params);
  return {
    params,
    timeShiftSec: shift,
    rmsCm: rmsCm(sim, problem.points, shift),
    segments: segmentReport(sim, problem.segments, shift),
  };
}

export interface PolishOptions {
  readonly free?: readonly ParamKey[];
  /** Evaluation budget for the whole-window stage. */
  readonly maxEvaluations?: number;
}

export interface PolishResult {
  readonly params: SimParams;
  readonly timeShiftSec: number;
  readonly rmsCm: number;
  readonly simulations: number;
}


/**
 * Numeric fine tuning from a starting point (spec §4: Nelder–Mead between
 * agent turns), in two stages, the way day 2 found the error surface needs:
 *
 * 1. μ_ramp (with v0 if free) on the ramp segment alone, where it is the only
 *    thing that matters and the surface is smooth;
 * 2. every free parameter on the whole window, starting from stage 1 with a
 *    small μ_ramp step, since a tiny μ change shifts every later contact.
 *
 * The release-time shift is held at `timeShiftSec` (from `fitReleaseShift`):
 * the whole-window error is far too jagged in it to search. Local, like any
 * simplex search: where it ends depends on where it starts. The agent (or
 * the numeric fallback's restarts) supplies the starts.
 */
export function polish(problem: FitProblem, start: SimParams, timeShiftSec = 0, options: PolishOptions = {}): PolishResult {
  const free = options.free ?? DEFAULT_FREE_PARAMS;
  const shift = clampShift(timeShiftSec);
  let simulations = 0;
  let current = clampParams(start);

  const minimise = (
    keys: readonly ParamKey[],
    score: (params: SimParams) => number,
    nmOptions: { maxEvaluations: number; xTolerance: number; fTolerance: number },
    stepScale: (k: ParamKey) => number,
  ) => {
    const unpack = (x: readonly number[]) => {
      const raw = { ...current };
      keys.forEach((k, i) => {
        raw[k] = x[i] ?? raw[k];
      });
      return { raw, params: clampParams(raw) };
    };
    const fit = nelderMead(
      (x) => {
        const { raw, params } = unpack(x);
        simulations++;
        // Clamp, and charge for the distance outside so the simplex walks back in.
        return score(params) + keys.reduce((sum, k) => sum + Math.abs(raw[k] - params[k]), 0);
      },
      keys.map((k) => current[k]),
      { steps: keys.map((k) => stepScale(k) * INITIAL_STEP[k]), ...nmOptions },
    );
    current = unpack(fit.x).params;
  };

  const rampKeys = free.filter((k) => k === 'muRamp' || k === 'v0');
  const rampEnd = problem.segments.ramp.at(-1)?.t ?? 0;
  if (rampKeys.length > 0) {
    minimise(
      rampKeys,
      (params) => rmsCm(simulateWindow(problem, params, rampEnd), problem.segments.ramp, shift),
      { maxEvaluations: 60, xTolerance: 1e-5, fTolerance: 1e-7 },
      () => 1,
    );
  }

  if (problem.points.length > problem.segments.ramp.length && free.length > 0) {
    const windowScore = (params: SimParams) => rmsCm(simulateWindow(problem, params), problem.points, shift);
    const afterRamp = current;
    // The whole-window error has several basins in e (a different bounce decides whether the ball reaches
    // the block before the freeze), so stage 2 also starts from two spread restitutions and keeps the best.
    const starts = free.includes('restitution')
      ? [afterRamp.restitution, ...RESTITUTION_SPREAD.filter((e) => Math.abs(e - afterRamp.restitution) > 0.1)]
      : [afterRamp.restitution];
    let best: { params: SimParams; rms: number } | null = null;
    for (const restitution of starts) {
      current = { ...afterRamp, restitution };
      minimise(
        free,
        windowScore,
        { maxEvaluations: options.maxEvaluations ?? 100, xTolerance: 1e-4, fTolerance: 1e-6 },
        (k) => (k === 'muRamp' ? 0.1 : 1),
      );
      simulations++;
      const rms = windowScore(current);
      if (!best || rms < best.rms) best = { params: current, rms };
    }
    if (best) current = best.params;
  }

  simulations++;
  return { params: current, timeShiftSec: shift, rmsCm: rmsCm(simulateWindow(problem, current), problem.points, shift), simulations };
}

export interface ReleaseShift {
  readonly timeShiftSec: number;
  /** μ_ramp that best fits the ramp at that shift. */
  readonly muRamp: number;
  readonly simulations: number;
}

/**
 * Refines the detected release time from the ramp segment, once per fit.
 *
 * On the ramp the ball accelerates uniformly, so its path pins down both the
 * acceleration (μ_ramp) and when it started. Their errors trade off along a
 * narrow valley, and over the whole window the error is far too jagged in the
 * shift to search (a millisecond decides whether the ball reaches the block
 * before the freeze). So the shift is chosen on the ramp alone, by a
 * golden-section search over the profile min over μ_ramp of the ramp RMS,
 * which is smooth and has one minimum, and then held while the physics is
 * fitted.
 */
export function fitReleaseShift(problem: FitProblem, start: SimParams): ReleaseShift {
  const rampEnd = problem.segments.ramp.at(-1)?.t ?? 0;
  let simulations = 0;
  let muRamp = clampParams(start).muRamp;
  const profile = (shift: number) => {
    const fit = nelderMead(
      ([mu = muRamp]) => {
        simulations++;
        const params = clampParams({ ...start, muRamp: mu });
        return rmsCm(simulateWindow(problem, params, rampEnd), problem.segments.ramp, shift) + Math.abs(mu - params.muRamp);
      },
      [muRamp],
      { steps: [INITIAL_STEP.muRamp], maxEvaluations: 40, xTolerance: 1e-5, fTolerance: 1e-8 },
    );
    // Warm-start the next profile point from this one; deterministic, since the search order is fixed.
    muRamp = clampParams({ ...start, muRamp: fit.x[0] ?? muRamp }).muRamp;
    return { value: fit.value, muRamp };
  };

  const phi = (Math.sqrt(5) - 1) / 2;
  let a = -MAX_TIME_SHIFT_SEC;
  let b = MAX_TIME_SHIFT_SEC;
  let c = b - phi * (b - a);
  let d = a + phi * (b - a);
  let fc = profile(c);
  let fd = profile(d);
  while (b - a > RELEASE_SHIFT_RESOLUTION_SEC) {
    if (fc.value < fd.value) {
      b = d;
      d = c;
      fd = fc;
      c = b - phi * (b - a);
      fc = profile(c);
    } else {
      a = c;
      c = d;
      fc = fd;
      d = a + phi * (b - a);
      fd = profile(d);
    }
  }
  const timeShiftSec = clampShift((a + b) / 2);
  return { timeShiftSec, muRamp: profile(timeShiftSec).muRamp, simulations };
}

/**
 * Smallest μ_ramp at which the ball rolls down this ramp without slipping. At
 * or above it the ramp segment no longer depends on μ_ramp, so a fitted value
 * there is only a lower bound.
 */
export function muRampRollingThreshold(world: WorldScene, ballKind: BallKind = 'solid'): number {
  const d = { x: world.ramp.bottom.x - world.ramp.top.x, y: world.ramp.bottom.y - world.ramp.top.y };
  const k = BALL_INERTIA_FACTOR[ballKind];
  return (k / (1 + k)) * Math.abs(d.y / d.x);
}
