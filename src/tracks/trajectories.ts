import { frameIndexOf, recordsOfKind, type SegmentationRecord } from '@meta-sam/parser';
import { pixelToWorld, type Calibration, type Vec2 } from '../scene/calibration';
import type { TrackedObject } from './samText';

/** Capture rate the filming guide asks for. Pass the clip's real rate when it is known. */
export const DEFAULT_FPS = 240;
/**
 * Frames whose box confidence is below this are dropped from the trajectory.
 * A first guess, like the day-1 go/no-go thresholds; tune once real takes are in.
 */
export const DEFAULT_MIN_CONFIDENCE = 0.5;

/** One tracked frame of one object. */
export interface TrajectoryPoint {
  readonly frame: number;
  /** Seconds from the start of the clip: frame / fps. */
  readonly t: number;
  /** Centre in the world frame, cm. */
  readonly x: number;
  readonly y: number;
  /** Centre in source pixels, for the overlay. */
  readonly px: Vec2;
  /** SAM's box confidence, or null when the response carried none (which does not mean zero). */
  readonly confidence: number | null;
}

export interface ObjectTrajectory {
  readonly object: TrackedObject;
  readonly fps: number;
  /** Kept frames, ascending. */
  readonly points: readonly TrajectoryPoint[];
  /** Frames with a box whose confidence was below the threshold, ascending. */
  readonly lowConfidenceFrames: readonly number[];
  /** Frames between the object's first and last box that have no box at all, ascending. */
  readonly missingFrames: readonly number[];
}

export interface TrajectoryOptions {
  readonly fps?: number;
  readonly minConfidence?: number;
}

/**
 * Turns parsed SAM 3.1 video records into one time series per prompted
 * object, in centimetres with timestamps from the clip's frame rate.
 *
 * The position is the box centre. For a round ball that is the mask centroid
 * unless something hides part of it, and it avoids decoding every mask.
 * Frames below the confidence threshold are dropped and listed; frames with
 * no box are listed as missing. Nothing is interpolated: the fitter compares
 * the simulation only where there is a measurement.
 */
export function tracksToTrajectories(
  records: readonly SegmentationRecord[],
  objects: readonly TrackedObject[],
  cal: Calibration,
  options: TrajectoryOptions = {},
): ObjectTrajectory[] {
  const fps = options.fps ?? DEFAULT_FPS;
  if (!(fps > 0)) throw new Error('fps must be positive');
  const minConfidence = options.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
  const boxes = recordsOfKind(records, 'box');

  return objects.map((object) => {
    const byFrame = new Map<number, (typeof boxes)[number]>();
    for (const box of boxes) {
      const frame = frameIndexOf(box);
      if (box.objectId !== object.id || frame === undefined) continue;
      // Streamed frames can arrive out of order; keep the first record per frame.
      if (!byFrame.has(frame)) byFrame.set(frame, box);
    }
    const sorted = [...byFrame.entries()].sort(([a], [b]) => a - b);
    const frames = sorted.map(([frame]) => frame);

    const points: TrajectoryPoint[] = [];
    const lowConfidenceFrames: number[] = [];
    for (const [frame, box] of sorted) {
      const confidence = box.confidence ?? null;
      if (confidence !== null && confidence < minConfidence) {
        lowConfidenceFrames.push(frame);
        continue;
      }
      // Half-open pixel boxes: pixel i spans [i, i + 1), so the centre is the midpoint of left and right.
      const px = { x: (box.left + box.right) / 2, y: (box.top + box.bottom) / 2 };
      const world = pixelToWorld(cal, px);
      points.push({ frame, t: frame / fps, x: world.x, y: world.y, px, confidence });
    }

    const missingFrames: number[] = [];
    const first = frames[0];
    const last = frames.at(-1);
    if (first !== undefined && last !== undefined) {
      for (let f = first; f <= last; f++) if (!byFrame.has(f)) missingFrames.push(f);
    }
    return { object, fps, points, lowConfidenceFrames, missingFrames };
  });
}
