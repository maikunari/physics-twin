import { DEFAULT_FREE_PARAMS, type FitProblem, type ParamKey } from '../fit/fitter';
import { DEFAULT_DT, simulateScene } from '../sim/sceneWorld';
import { ENSEMBLE_SEED, ENSEMBLE_SIZE, fitUncertainty, sampleEnsemble, type FitUncertainty, type FittedRun } from './ensemble';
import { findEvent, firstEvent, type EventKind, type PathEvent, type PathPoint } from './events';

/** How far past the freeze the prediction runs, s: the second after the fitted one, or less if the clip ends first. */
export const PREDICT_HORIZON_SEC = 1.0;

/** One simulated future: a fitted (or sampled) run played past the freeze. */
export interface PredictedRun extends FittedRun {
  /** The first event of the committed kind after the freeze, or null if this run never has one before the horizon. */
  readonly event: PathEvent | null;
  /** Where the ball is at the horizon. */
  readonly end: PathPoint;
  /** The path from the freeze to the horizon, measured clock, cm. */
  readonly path: readonly PathPoint[];
}

/** The spread of the ensemble's event: what "98 cm ± 2 cm" is drawn from. */
export interface PredictionBand {
  readonly kind: EventKind;
  /** Runs of the ensemble that have the event before the horizon. */
  readonly agreeing: number;
  readonly total: number;
  /** Event position along the table and time over the agreeing runs, cm and s. */
  readonly x: readonly [number, number];
  readonly t: readonly [number, number];
}

/**
 * A prediction made at the freeze, from the fit window alone. Times are on
 * the measured clock: seconds from the detected release, the clock the fit
 * window is cut on (a run's simulated time t is measured time t + its
 * release correction).
 */
export interface Prediction {
  readonly freezeSec: number;
  readonly horizonEndSec: number;
  /** The fit's window RMS, cm. */
  readonly fitRmsCm: number;
  readonly nominal: PredictedRun & { readonly event: PathEvent };
  readonly members: readonly PredictedRun[];
  readonly band: PredictionBand;
  readonly uncertainty: FitUncertainty;
}

export interface PredictOptions {
  /** When the clip ends on the measured clock: the horizon never runs past it. */
  readonly clipEndSec?: number;
  readonly horizonSec?: number;
  readonly free?: readonly ParamKey[];
  readonly ensembleSize?: number;
  readonly seed?: number;
}

/** The whole run from the release to `untilSec`, on the measured clock. */
function runPath(problem: FitProblem, run: FittedRun, untilSec: number): PathPoint[] {
  const sim = simulateScene(problem.world, run.params, {
    durationSec: Math.max(0, untilSec - run.timeShiftSec) + 2 * DEFAULT_DT,
    ...(problem.ballKind ? { ballKind: problem.ballKind } : {}),
  });
  return sim.samples.map((s) => ({ t: s.t + run.timeShiftSec, x: s.x, y: s.y }));
}

function predictRun(
  problem: FitProblem,
  run: FittedRun,
  kind: EventKind,
  horizonEndSec: number,
  path: readonly PathPoint[] = runPath(problem, run, horizonEndSec),
): PredictedRun {
  const freeze = problem.windowEndSec;
  const end = findEvent(path, problem.world, 'horizon', freeze, horizonEndSec);
  if (!end) throw new Error('simulation stopped before the horizon');
  return {
    ...run,
    event: findEvent(path, problem.world, kind, freeze, horizonEndSec),
    end,
    // One step either side, so the path covers the whole span when interpolated.
    path: path.filter((p) => p.t >= freeze - DEFAULT_DT && p.t <= horizonEndSec + DEFAULT_DT),
  };
}

/**
 * Freezes the fit and predicts the rest of the take (spec §5): the fitted run
 * is played past the freeze to find the first event after it (touchdown,
 * turnaround, or the position at the horizon, see `firstEvent`), and an
 * ensemble of 12 runs sampled within the fit's uncertainty gives the band
 * for that same event.
 *
 * Reads only `problem` and the fit, so nothing after the freeze: a
 * FitProblem holds no measured point past its window.
 */
export function makePrediction(problem: FitProblem, fit: FittedRun & { readonly rmsCm: number }, options: PredictOptions = {}): Prediction {
  const freezeSec = problem.windowEndSec;
  const horizonEndSec = Math.min(freezeSec + (options.horizonSec ?? PREDICT_HORIZON_SEC), options.clipEndSec ?? Number.POSITIVE_INFINITY);
  if (!(horizonEndSec > freezeSec)) throw new Error('the clip ends at the freeze: nothing left to predict');

  const run: FittedRun = { params: fit.params, timeShiftSec: fit.timeShiftSec };
  const nominalPath = runPath(problem, run, horizonEndSec);
  const event = firstEvent(nominalPath, problem.world, freezeSec, horizonEndSec);
  if (!event) throw new Error('simulation stopped before the horizon');
  const nominal = { ...predictRun(problem, run, event.kind, horizonEndSec, nominalPath), event };

  const uncertainty = fitUncertainty(problem, run, options.free ?? DEFAULT_FREE_PARAMS);
  const members = sampleEnsemble(run, uncertainty, options.ensembleSize ?? ENSEMBLE_SIZE, options.seed ?? ENSEMBLE_SEED).map((m) =>
    predictRun(problem, m, event.kind, horizonEndSec),
  );
  const events = members.flatMap((m) => (m.event ? [m.event] : []));
  // The nominal run is in the band too, so a band always exists even if no member agrees.
  const xs = [event.x, ...events.map((e) => e.x)];
  const ts = [event.t, ...events.map((e) => e.t)];
  return {
    freezeSec,
    horizonEndSec,
    fitRmsCm: fit.rmsCm,
    nominal,
    members,
    band: {
      kind: event.kind,
      agreeing: events.length,
      total: members.length,
      x: [Math.min(...xs), Math.max(...xs)],
      t: [Math.min(...ts), Math.max(...ts)],
    },
    uncertainty,
  };
}
