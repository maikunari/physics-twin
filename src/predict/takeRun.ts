import { createActor } from 'xstate';
import { runFitSession, type FitLogEntry, type FitSessionResult, type Proposer } from '../fit/session';
import { predictFlowMachine } from '../machines/predictFlow';
import { loadOverlayData, predictionInputs } from '../overlay/overlayData';
import { DEFAULT_SIM_PARAMS } from '../sim/params';
import { commitPrediction, type Commitment } from './commitment';
import { makePrediction, type Prediction } from './prediction';
import { scoreReveal, type RevealOutcome } from './reveal';

export interface TakeInputs {
  /** The take's name, e.g. A01; it goes into the commitment. */
  readonly take: string;
  readonly sceneJson: string;
  readonly samText: string;
  readonly fps: number;
  readonly markerDistanceCm?: number;
  /** The Muse Spark fitting agent; omit for Nelder–Mead alone. */
  readonly agent?: Proposer;
  readonly onLog?: (entry: FitLogEntry) => void;
  /**
   * Called with the commitment as soon as it is made, before the measured
   * track past the freeze is read. The results script writes it to disk here.
   */
  readonly onCommit?: (commitment: Commitment, prediction: Prediction) => void | Promise<void>;
}

export interface TakeRun {
  readonly take: string;
  /** Detected release, clip seconds: the prediction's clock starts here. */
  readonly releaseSec: number;
  readonly pixelsPerCm: number;
  readonly fit: FitSessionResult;
  readonly prediction: Prediction;
  readonly commitment: Commitment;
  readonly outcome: RevealOutcome;
}

/**
 * One take through the whole pipeline, the same steps as the page: load the
 * scene and SAM tracks, fit the first second after the release, freeze,
 * predict and commit, then reveal and score. The predict flow machine sets
 * the order: there is no outcome without a commitment made first.
 *
 * The fit and the prediction get only the fit problem, which holds nothing
 * after the freeze; the full track is read only after the commitment.
 * Rapier must be initialised first.
 */
export async function runTake(inputs: TakeInputs): Promise<TakeRun> {
  const data = loadOverlayData({
    sceneJson: inputs.sceneJson,
    samText: inputs.samText,
    fps: inputs.fps,
    params: DEFAULT_SIM_PARAMS,
    ...(inputs.markerDistanceCm ? { markerDistanceCm: inputs.markerDistanceCm } : {}),
  });
  const { problem, measured, clipEndSec } = predictionInputs(data, data.releaseSec);

  const fit = await runFitSession(problem, DEFAULT_SIM_PARAMS, {
    ...(inputs.agent ? { agent: inputs.agent } : {}),
    ...(inputs.onLog ? { onLog: inputs.onLog } : {}),
  });

  const flow = createActor(predictFlowMachine).start();
  flow.send({ type: 'PREDICT' });
  let prediction: Prediction;
  let commitment: Commitment;
  try {
    prediction = makePrediction(problem, fit.best, { clipEndSec });
    commitment = await commitPrediction(inputs.take, prediction);
  } catch (err) {
    flow.send({ type: 'PREDICTION_FAILED', error: err instanceof Error ? err.message : String(err) });
    throw err;
  }
  flow.send({ type: 'PREDICTION_READY', prediction, commitment });
  await inputs.onCommit?.(commitment, prediction);

  flow.send({ type: 'REVEAL' });
  if (!flow.getSnapshot().matches('revealing')) throw new Error('the predict flow refused the reveal');
  const outcome = scoreReveal({
    prediction,
    commitment,
    measured,
    world: data.world,
    pixelsPerCm: data.calibration.pixelsPerCm,
    fps: inputs.fps,
  });
  flow.send({ type: 'REVEAL_DONE', outcome });
  if (!flow.getSnapshot().matches('result')) throw new Error('the predict flow refused the outcome');

  return {
    take: inputs.take,
    releaseSec: data.releaseSec,
    pixelsPerCm: data.calibration.pixelsPerCm,
    fit,
    prediction,
    commitment,
    outcome,
  };
}
