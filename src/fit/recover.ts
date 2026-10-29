import type { WorldScene } from '../scene/calibration';
import { BALL_INERTIA_FACTOR, type BallKind, type SimParams } from '../sim/params';
import { DEFAULT_DT, simulateScene } from '../sim/sceneWorld';
import type { TrajectoryPoint } from '../tracks/trajectories';
import { rmsCm, splitAtRampEnd, withinWindow } from './score';

/** Fit window from spec §5: the fitter reads the first second and nothing after. */
export const DEFAULT_WINDOW_END_SEC = 1.0;

/** Stage 2 scans μ_ramp ± this many steps of this size around the stage-1 value. */
const MU_BAND_STEPS = 3;
const MU_BAND_STEP = 0.0005;
/** Stage 2's coarse restitution grid: 0.025 steps over the default range. */
const E_GRID_STEPS = 38;

export interface RecoverOptions {
  /** Every parameter other than μ_ramp and e is held at this value. */
  readonly base: SimParams;
  readonly windowEndSec?: number;
  readonly ballKind?: BallKind;
  readonly muRange?: readonly [number, number];
  readonly restitutionRange?: readonly [number, number];
}

export interface Recovery {
  readonly params: SimParams;
  /** RMS on the ramp segment at the fitted μ_ramp, cm. */
  readonly rampRmsCm: number;
  /** RMS after the ramp (flight, bounce, roll) at the fitted e, cm. */
  readonly afterRmsCm: number;
  /** RMS over the whole fit window, cm. */
  readonly rmsCm: number;
  /**
   * Smallest μ_ramp at which the ball rolls down this ramp without slipping.
   * At or above it the ramp segment no longer depends on μ_ramp, so a fitted
   * value near it is only a lower bound.
   */
  readonly muRampRollingThreshold: number;
  readonly muRampIdentifiable: boolean;
  readonly simulations: number;
}

/** Golden-section search for a minimum of `f` on [lo, hi]. */
function goldenSection(f: (x: number) => number, lo: number, hi: number, iterations: number): number {
  const phi = (Math.sqrt(5) - 1) / 2;
  let a = lo;
  let b = hi;
  let c = b - phi * (b - a);
  let d = a + phi * (b - a);
  let fc = f(c);
  let fd = f(d);
  for (let i = 0; i < iterations; i++) {
    if (fc < fd) {
      b = d;
      d = c;
      fd = fc;
      c = b - phi * (b - a);
      fc = f(c);
    } else {
      a = c;
      c = d;
      fc = fd;
      d = a + phi * (b - a);
      fd = f(d);
    }
  }
  return (a + b) / 2;
}

/** A coarse grid scan, then golden-section refinement around the best grid point. */
function minimise1d(f: (x: number) => number, lo: number, hi: number, steps: number): number {
  const step = (hi - lo) / steps;
  let best = lo;
  let bestValue = Number.POSITIVE_INFINITY;
  for (let i = 0; i <= steps; i++) {
    const x = lo + i * step;
    const v = f(x);
    if (v < bestValue) {
      bestValue = v;
      best = x;
    }
  }
  const refined = goldenSection(f, Math.max(lo, best - step), Math.min(hi, best + step), 12);
  return f(refined) <= bestValue ? refined : best;
}

/**
 * Day-2 numeric recovery of μ_ramp and restitution from a measured ball path,
 * one parameter per segment: μ_ramp from the ramp segment (where it sets the
 * acceleration), then e from everything after it with μ_ramp fixed. Fitting
 * both on the whole window at once gives a jagged error surface, because a
 * small change in μ shifts when every later bounce happens.
 *
 * Only points inside the fit window are read. The Muse Spark agent and the
 * Nelder–Mead fitter over all parameters replace this on day 3.
 */
export function recoverMuAndRestitution(
  scene: WorldScene,
  points: readonly TrajectoryPoint[],
  options: RecoverOptions,
): Recovery {
  const windowEndSec = options.windowEndSec ?? DEFAULT_WINDOW_END_SEC;
  const [muLo, muHi] = options.muRange ?? [0.01, 0.6];
  const [eLo, eHi] = options.restitutionRange ?? [0, 0.95];
  const visible = withinWindow(points, windowEndSec);
  const { ramp, after } = splitAtRampEnd(visible, scene);
  if (ramp.length < 2) throw new Error('need at least two measured points on the ramp');
  if (after.length < 2) throw new Error('need at least two measured points after the ramp');

  let simulations = 0;
  const run = (params: SimParams, durationSec: number) => {
    simulations++;
    return simulateScene(scene, params, {
      durationSec: durationSec + DEFAULT_DT,
      ...(options.ballKind ? { ballKind: options.ballKind } : {}),
    });
  };
  const rampEnd = ramp.at(-1)?.t ?? 0;
  const windowEnd = Math.min(windowEndSec, visible.at(-1)?.t ?? windowEndSec);

  // Stage 1: μ_ramp alone, on the ramp segment.
  const muRamp = minimise1d((mu) => rmsCm(run({ ...options.base, muRamp: mu }, rampEnd), ramp), muLo, muHi, 59);

  // Stage 2: e on everything after the ramp. A μ_ramp error far below the
  // noise can still change which contacts happen later (does the ball reach
  // the block inside the window?), so e is scanned against a narrow band of
  // μ_ramp around the stage-1 value, scored on the whole window.
  const scoreWindow = (mu: number, e: number) =>
    rmsCm(run({ ...options.base, muRamp: mu, restitution: e }, windowEnd), visible);
  let best = { mu: muRamp, e: eLo, rms: Number.POSITIVE_INFINITY };
  for (let i = -MU_BAND_STEPS; i <= MU_BAND_STEPS; i++) {
    const mu = Math.min(muHi, Math.max(muLo, muRamp + i * MU_BAND_STEP));
    for (let j = 0; j <= E_GRID_STEPS; j++) {
      const e = eLo + ((eHi - eLo) * j) / E_GRID_STEPS;
      const rms = scoreWindow(mu, e);
      if (rms < best.rms) best = { mu, e, rms };
    }
  }
  const eStep = (eHi - eLo) / E_GRID_STEPS;
  const refined = minimise1d(
    (e) => rmsCm(run({ ...options.base, muRamp: best.mu, restitution: e }, windowEnd), after),
    Math.max(eLo, best.e - eStep),
    Math.min(eHi, best.e + eStep),
    10,
  );
  const restitution = scoreWindow(best.mu, refined) <= best.rms ? refined : best.e;
  const params = { ...options.base, muRamp: best.mu, restitution };
  const fitted = run(params, windowEnd);

  const d = { x: scene.ramp.bottom.x - scene.ramp.top.x, y: scene.ramp.bottom.y - scene.ramp.top.y };
  const tanTheta = Math.abs(d.y / d.x);
  const k = BALL_INERTIA_FACTOR[options.ballKind ?? 'solid'];
  const muRampRollingThreshold = (k / (1 + k)) * tanTheta;

  return {
    params,
    rampRmsCm: rmsCm(fitted, ramp),
    afterRmsCm: rmsCm(fitted, after),
    rmsCm: rmsCm(fitted, visible),
    muRampRollingThreshold,
    // A margin under the threshold: right at it the ball barely slips and the fit cannot tell.
    muRampIdentifiable: muRamp < 0.9 * muRampRollingThreshold,
    simulations,
  };
}
