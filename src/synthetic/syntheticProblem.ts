import { makeFitProblem, type FitProblem } from '../fit/fitter';
import { FIXTURE_IMAGE_SIZE, FIXTURE_SCENE } from '../scene/fixtures';
import { DEFAULT_SIM_PARAMS, type SimParams } from '../sim/params';
import { parseSamText } from '../tracks/samText';
import { tracksToTrajectories, type TrajectoryPoint } from '../tracks/trajectories';
import { makeSyntheticTake, type SyntheticTake } from './syntheticTake';

/** The measurement faults the day-2 ground-truth test uses: 0.7 px jitter, 5% lost frames, 3% wrong boxes. */
export const SYNTHETIC_MEASUREMENT = { pixelNoise: 0.7, dropRate: 0.05, lowConfidenceRate: 0.03 } as const;

/** Day-2 truths: the parameters a synthetic take is made from, with the held ones at fixed values. */
export const syntheticTruth = (muRamp: number, restitution: number): SimParams => ({
  ...DEFAULT_SIM_PARAMS,
  muRamp,
  muTable: 0.25,
  restitution,
  rollingDamping: 0.2,
});

export interface SyntheticFitCase {
  readonly take: SyntheticTake;
  /** Every measured ball point of the take, past the fit window too. */
  readonly points: readonly TrajectoryPoint[];
  readonly problem: FitProblem;
}

/**
 * A synthetic take of the fixture scene, measured through the real SAM parser
 * and tracks pipeline, and the fit problem built from it (release at frame 0).
 * `durationSec` past the 1.0 s window is footage a prediction is checked against.
 */
export function syntheticFitCase(truth: SimParams, seed: number, durationSec = 1.5): SyntheticFitCase {
  const take = makeSyntheticTake(FIXTURE_SCENE, FIXTURE_IMAGE_SIZE, truth, { durationSec, seed, ...SYNTHETIC_MEASUREMENT });
  const [ball] = tracksToTrajectories(parseSamText(take.samText).records, take.objects, take.calibration);
  if (!ball) throw new Error('synthetic take has no ball track');
  return { take, points: ball.points, problem: makeFitProblem(take.world, ball.points) };
}
