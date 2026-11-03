import { pixelToWorld, worldToPixel, type Vec2 } from '../scene/calibration';
import { distanceCm, findEvent, positionAt, type PathEvent, type PathPoint } from '../predict/events';
import { ballTrajectory, type OverlayData } from '../overlay/overlayData';
import { rampAngleDeg } from './applyEdit';
import { firstLanding, type ScenarioRun } from './run';

/** A measured point further than this from its neighbour in time means the tracker lost the ball there, frames. */
const MAX_GAP_FRAMES = 3;
/**
 * The camera stays put between takes (filming guide), so a counterfactual
 * take's table and ramp foot should land on the baseline's pixels. Past this
 * the comparison is flagged: the camera or the table probably moved.
 */
export const CAMERA_SHIFT_WARN_PX = 8;

/** A measured ball point of a counterfactual take, in the baseline take's world frame. */
export interface CounterfactualPoint extends PathPoint {
  /** Source pixels, for drawing on the baseline clip. */
  readonly px: Vec2;
}

/**
 * A real take filmed with the change made for real (set B steeper, C block
 * removed, D both), read into the baseline take's world frame so the twin's
 * what-if and reality are compared in the same centimetres.
 */
export interface CounterfactualTake {
  readonly take: string;
  /** Ball points from this take's own detected release, baseline world frame. */
  readonly points: readonly CounterfactualPoint[];
  readonly fps: number;
  /** The ramp angle Muse Spark read on this take's own frame 0, degrees. */
  readonly rampAngleDeg: number;
  /** The blocks grounded on this take's frame 0. */
  readonly blockIds: readonly string[];
  /** How far this take's table origin and ramp foot sit from the baseline's on the image, px (worst of the two). */
  readonly cameraShiftPx: number;
  /** A synthetic preset: drawn from the simulation, never filmed, so never called real. */
  readonly synthetic?: boolean;
}

/**
 * Reads a counterfactual take into the baseline's frame. The ball's pixels go
 * through the baseline's calibration, not the take's own: the camera did not
 * move, so the same pixel is the same place, and the take's own grounding
 * (a few pixels off from the baseline's) would only add noise. Its release
 * comes from its own track, with the same detector as every take.
 */
export function counterfactualFrom(
  baselineData: Pick<OverlayData, 'calibration' | 'world'>,
  take: string,
  data: OverlayData,
): CounterfactualTake {
  const baseline = baselineData.calibration;
  const { width, height } = baseline.imageSize;
  if (data.calibration.imageSize.width !== width || data.calibration.imageSize.height !== height) {
    throw new Error(
      `${take} is ${data.calibration.imageSize.width}x${data.calibration.imageSize.height}, the baseline ${width}x${height}: not the same camera setup`,
    );
  }
  const ball = ballTrajectory(data);
  if (!ball) throw new Error(`${take} has no ball track`);
  const points = ball.points
    .filter((p) => p.t >= data.releaseSec)
    .map((p) => ({ t: p.t - data.releaseSec, ...pixelToWorld(baseline, p.px), px: p.px }));
  const footPx = worldToPixel(data.calibration, data.world.ramp.bottom);
  const baselineFoot = worldToPixel(baseline, baselineData.world.ramp.bottom);
  const ownOrigin = data.calibration.originPx;
  return {
    take,
    points,
    fps: data.fps,
    rampAngleDeg: rampAngleDeg(data.world),
    blockIds: data.world.blocks.map((b) => b.id),
    cameraShiftPx: Math.max(
      Math.hypot(ownOrigin.x - baseline.originPx.x, ownOrigin.y - baseline.originPx.y),
      Math.hypot(footPx.x - baselineFoot.x, footPx.y - baselineFoot.y),
    ),
  };
}

export interface EventComparison {
  readonly predicted: PathEvent | null;
  readonly real: PathEvent | null;
  /** Distance between the two, cm and px; null unless both happened. */
  readonly errorCm: number | null;
  readonly errorPx: number | null;
  /** Real minus predicted, ms. */
  readonly errorMs: number | null;
}

/** The amber run against the real counterfactual take, every number on the same clock (each from its own release). */
export interface WhatIfComparison {
  readonly take: string;
  /** Real ramp angle (this take's grounding) against the one the edit asked for, degrees. */
  readonly rampAngleDeg: { readonly asked: number; readonly real: number };
  readonly landing: EventComparison;
  readonly turnaround: EventComparison;
  /** Position at the last time both cover. */
  readonly end: { readonly t: number; readonly predicted: PathPoint | null; readonly real: PathPoint | null; readonly errorCm: number | null; readonly errorPx: number | null };
  /** Run against every real point both cover, from the release. */
  readonly trajectory: { readonly points: number; readonly rmsMm: number | null; readonly rmsPx: number | null };
  readonly cameraShiftPx: number;
  readonly cameraMoved: boolean;
}

function compareEvents(predicted: PathEvent | null, real: PathEvent | null, pixelsPerCm: number): EventComparison {
  const errorCm = predicted && real ? distanceCm(predicted, real) : null;
  return {
    predicted,
    real,
    errorCm,
    errorPx: errorCm === null ? null : errorCm * pixelsPerCm,
    errorMs: predicted && real ? (real.t - predicted.t) * 1000 : null,
  };
}

/**
 * Scores a what-if against the real take of the same change (spec §8,
 * 1:50–2:20). The what-if was made from the baseline take's fit alone; the
 * counterfactual take is read only here. Each event is found by one
 * detector run on both paths, against the edited scene.
 */
export function compareWhatIf(run: ScenarioRun, real: CounterfactualTake, pixelsPerCm: number): WhatIfComparison {
  const lastReal = real.points.at(-1)?.t ?? 0;
  const until = Math.min(run.untilSec, lastReal);
  const maxGap = MAX_GAP_FRAMES / real.fps + 1e-9;
  const covered = real.points.filter((p) => p.t >= 0 && p.t <= until);
  let sum = 0;
  let n = 0;
  for (const p of covered) {
    const s = positionAt(run.path, p.t);
    if (!s) continue;
    sum += (s.x - p.x) ** 2 + (s.y - p.y) ** 2;
    n++;
  }
  const rmsCm = n ? Math.sqrt(sum / n) : null;
  const predictedEnd = positionAt(run.path, until);
  const realEnd = positionAt(real.points, until, maxGap);
  const endCm = predictedEnd && realEnd ? distanceCm(predictedEnd, realEnd) : null;
  return {
    take: real.take,
    rampAngleDeg: { asked: run.rampAngleDeg, real: real.rampAngleDeg },
    landing: compareEvents(firstLanding(run.path, run.world, until), firstLanding(real.points, run.world, until), pixelsPerCm),
    turnaround: compareEvents(
      findEvent(run.path, run.world, 'turnaround', 0, until),
      findEvent(real.points, run.world, 'turnaround', 0, until),
      pixelsPerCm,
    ),
    end: { t: until, predicted: predictedEnd, real: realEnd, errorCm: endCm, errorPx: endCm === null ? null : endCm * pixelsPerCm },
    trajectory: { points: n, rmsMm: rmsCm === null ? null : rmsCm * 10, rmsPx: rmsCm === null ? null : rmsCm * pixelsPerCm },
    cameraShiftPx: real.cameraShiftPx,
    cameraMoved: real.cameraShiftPx > CAMERA_SHIFT_WARN_PX,
  };
}
