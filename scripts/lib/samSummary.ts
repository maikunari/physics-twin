import { frameIndexOf, recordsOfKind, type SegmentationRecord } from '@meta-sam/parser';
import { MIN_BALL_TRACK_FRAMES } from '../../src/machines/appFlow';

export interface PromptedObject {
  readonly id: string;
  readonly kind: 'ball' | 'block';
  readonly label: string;
}

export interface ObjectTrackSummary extends PromptedObject {
  readonly framesWithBox: number;
  readonly firstFrame: number | null;
  readonly lastFrame: number | null;
  /** Longest run of consecutive frames with a box. */
  readonly longestRun: number;
  readonly meanConfidence: number | null;
  readonly minConfidence: number | null;
  /** Largest jump of the box centre between consecutive tracked frames, px; a spike hints at an id swap. */
  readonly maxStepPx: number;
  /** Box centre per tracked frame, ascending by frame. */
  readonly path: readonly { readonly frame: number; readonly cx: number; readonly cy: number }[];
}

export interface GoNoGo {
  readonly go: boolean;
  readonly reasons: readonly string[];
}

/** Heuristic go/no-go thresholds for the day-1 test take; tune once real takes are in. */
export const GO_THRESHOLDS = {
  /** Share of frames in the fit window (first second) where the ball has a box. */
  minFitWindowCoverage: 0.9,
  minMeanConfidence: 0.5,
  /** Max centre jump between consecutive frames, in ball diameters. */
  maxStepDiameters: 1.5,
} as const;

export function summariseTracks(
  records: readonly SegmentationRecord[],
  objects: readonly PromptedObject[],
): ObjectTrackSummary[] {
  const boxes = recordsOfKind(records, 'box');
  return objects.map((object) => {
    const byFrame = new Map<number, (typeof boxes)[number]>();
    for (const box of boxes) {
      const frame = frameIndexOf(box);
      if (box.objectId !== object.id || frame === undefined) continue;
      // Streamed frames can arrive out of order; keep the first record per frame.
      if (!byFrame.has(frame)) byFrame.set(frame, box);
    }
    const path = [...byFrame.entries()]
      .sort(([a], [b]) => a - b)
      .map(([frame, b]) => ({ frame, cx: (b.left + b.right) / 2, cy: (b.top + b.bottom) / 2 }));
    const frames = path.map((p) => p.frame);
    let longestRun = 0;
    let run = 0;
    let maxStepPx = 0;
    frames.forEach((frame, i) => {
      const prev = frames[i - 1];
      run = prev !== undefined && frame === prev + 1 ? run + 1 : 1;
      longestRun = Math.max(longestRun, run);
      const a = path[i - 1];
      const b = path[i];
      if (a && b) maxStepPx = Math.max(maxStepPx, Math.hypot(b.cx - a.cx, b.cy - a.cy));
    });
    const confidences = [...byFrame.values()].flatMap((b) => (b.confidence === undefined ? [] : [b.confidence]));
    return {
      ...object,
      framesWithBox: frames.length,
      firstFrame: frames[0] ?? null,
      lastFrame: frames.at(-1) ?? null,
      longestRun,
      meanConfidence: confidences.length ? confidences.reduce((s, c) => s + c, 0) / confidences.length : null,
      minConfidence: confidences.length ? Math.min(...confidences) : null,
      maxStepPx,
      path,
    };
  });
}

/**
 * Day-1 go/no-go on the ball track: enough frames for AppFlow's TRACKS_READY
 * guard, near-complete coverage of the first second, decent confidence and no
 * jumps that look like the tracker hopping to another object.
 */
export function goNoGo(ball: ObjectTrackSummary | undefined, fps: number, ballDiameterPx: number): GoNoGo {
  if (!ball) return { go: false, reasons: ['no ball object in the results'] };
  const reasons: string[] = [];
  if (ball.framesWithBox < MIN_BALL_TRACK_FRAMES) {
    reasons.push(`ball tracked on ${ball.framesWithBox} frames, need ${MIN_BALL_TRACK_FRAMES}`);
  }
  const windowFrames = Math.max(1, Math.round(fps));
  const inWindow = ball.path.filter((p) => p.frame < windowFrames).length;
  const coverage = inWindow / windowFrames;
  if (coverage < GO_THRESHOLDS.minFitWindowCoverage) {
    reasons.push(`ball has a box on ${(coverage * 100).toFixed(0)}% of the first second's ${windowFrames} frames, need ${GO_THRESHOLDS.minFitWindowCoverage * 100}%`);
  }
  if (ball.meanConfidence !== null && ball.meanConfidence < GO_THRESHOLDS.minMeanConfidence) {
    reasons.push(`mean confidence ${ball.meanConfidence.toFixed(2)} is below ${GO_THRESHOLDS.minMeanConfidence}`);
  }
  if (ballDiameterPx > 0 && ball.maxStepPx > GO_THRESHOLDS.maxStepDiameters * ballDiameterPx) {
    reasons.push(`box centre jumps ${ball.maxStepPx.toFixed(0)} px in one frame (> ${GO_THRESHOLDS.maxStepDiameters} ball diameters)`);
  }
  return { go: reasons.length === 0, reasons };
}
