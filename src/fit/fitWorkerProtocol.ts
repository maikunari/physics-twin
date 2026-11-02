import { createFitAgent } from '../agent/fitAgent';
import type { SparkTransport } from '../agent/sparkWire';
import type { WorldScene } from '../scene/calibration';
import type { BallKind, SimParams } from '../sim/params';
import { initRapier } from '../sim/sceneWorld';
import type { TrajectoryPoint } from '../tracks/trajectories';
import { makeFitProblem } from './fitter';
import { DEFAULT_WINDOW_END_SEC } from './recover';
import { withinWindow } from './score';
import { runFitSession, type FitLogEntry, type FitProgress, type FitSessionResult } from './session';

/** Main thread → fit worker. Plain data, so it survives structured cloning. */
export interface FitRequest {
  readonly type: 'fit';
  readonly world: WorldScene;
  /** Ball points with t from the release, already cut at the window end. */
  readonly points: readonly TrajectoryPoint[];
  readonly windowEndSec: number;
  readonly initial: SimParams;
  /** Ask Muse Spark for proposals; without it the fit is Nelder–Mead alone. */
  readonly useAgent: boolean;
  readonly ballKind?: BallKind;
}

/** Fit worker → main thread. */
export type FitWorkerMessage =
  | { readonly type: 'log'; readonly entry: FitLogEntry }
  | { readonly type: 'progress'; readonly progress: FitProgress }
  | { readonly type: 'done'; readonly result: FitSessionResult }
  | { readonly type: 'failed'; readonly message: string };

/**
 * Builds the worker request from a take's ball points (t from the release).
 * The fit window is applied here, before anything is posted, so the worker
 * never receives a frame after the freeze time; the worker cuts again on
 * arrival.
 */
export function fitRequestFor(input: {
  readonly world: WorldScene;
  readonly points: readonly TrajectoryPoint[];
  readonly initial: SimParams;
  readonly useAgent: boolean;
  readonly windowEndSec?: number;
}): FitRequest {
  const windowEndSec = input.windowEndSec ?? DEFAULT_WINDOW_END_SEC;
  return {
    type: 'fit',
    world: input.world,
    points: withinWindow(input.points, windowEndSec),
    windowEndSec,
    initial: input.initial,
    useAgent: input.useAgent,
  };
}

/** Runs one fit request, posting log lines and progress as they happen. The worker's whole job, testable without a worker. */
export async function handleFitRequest(
  request: FitRequest,
  post: (message: FitWorkerMessage) => void,
  transport: SparkTransport,
): Promise<void> {
  try {
    await initRapier();
    const problem = makeFitProblem(request.world, request.points, {
      windowEndSec: request.windowEndSec,
      ...(request.ballKind ? { ballKind: request.ballKind } : {}),
    });
    const result = await runFitSession(problem, request.initial, {
      ...(request.useAgent ? { agent: createFitAgent({ transport }) } : {}),
      onLog: (entry) => post({ type: 'log', entry }),
      onProgress: (progress) => post({ type: 'progress', progress }),
    });
    post({ type: 'done', result });
  } catch (err) {
    post({ type: 'failed', message: err instanceof Error ? err.message : String(err) });
  }
}
