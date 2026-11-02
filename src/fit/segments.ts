import type { WorldScene } from '../scene/calibration';
import type { Trajectory } from '../sim/sceneWorld';
import type { TrajectoryPoint } from '../tracks/trajectories';
import { sampleAt, splitAtRampEnd } from './score';

/** The four parts of a run the fitting agent reasons about (spec §4). */
export const SEGMENT_NAMES = ['ramp', 'flight', 'bounce', 'roll'] as const;
export type SegmentName = (typeof SEGMENT_NAMES)[number];

export type MeasuredSegments = Readonly<Record<SegmentName, readonly TrajectoryPoint[]>>;

/**
 * A measured centre within this much of resting height counts as touching the
 * table, cm. Wide enough for tracker jitter, narrow enough that a real bounce
 * of a few millimetres still reads as off the table.
 */
const CONTACT_TOLERANCE_CM = 0.25;

/**
 * Splits the measured path into segments, from the measurements alone so the
 * split stays fixed while the fitter changes parameters:
 *
 * - ramp: the centre has not passed the ramp's low end;
 * - flight: after the ramp, before the ball first touches the table;
 * - bounce: from the first touch until the ball stays on the table;
 * - roll: from there to the end of the points given.
 *
 * Height is measured from the table line (the world frame's y = 0), so a
 * ball on the table sits at its radius. A segment the run never reached is
 * empty.
 */
export function splitSegments(points: readonly TrajectoryPoint[], scene: WorldScene): MeasuredSegments {
  const { ramp, after } = splitAtRampEnd(points, scene);
  const onTable = (p: TrajectoryPoint) => p.y <= scene.ball.radius + CONTACT_TOLERANCE_CM;
  const touch = after.findIndex(onTable);
  if (touch < 0) return { ramp, flight: after, bounce: [], roll: [] };
  // The roll is the run of on-table points that lasts to the end; anything before it, from the first touch, is bouncing.
  let rollFrom = after.length;
  while (rollFrom > touch && onTable(after[rollFrom - 1] as TrajectoryPoint)) rollFrom--;
  return {
    ramp,
    flight: after.slice(0, touch),
    bounce: after.slice(touch, rollFrom),
    roll: after.slice(rollFrom),
  };
}

/** How far the simulation is from the measurements over one segment. */
export interface SegmentError {
  readonly points: number;
  readonly rmsCm: number;
  /** Mean simulated minus measured position, cm: positive x means the simulated ball is further along. */
  readonly meanOffsetCm: { readonly x: number; readonly y: number };
  /** Largest single distance, cm. */
  readonly maxCm: number;
}

export type SegmentReport = Readonly<Record<SegmentName, SegmentError | null>>;

/** `shiftSec` moves the measured clock as in `rmsCm`. */
export function segmentError(sim: Trajectory, points: readonly TrajectoryPoint[], shiftSec = 0): SegmentError | null {
  if (points.length === 0) return null;
  let sum = 0;
  let dx = 0;
  let dy = 0;
  let max = 0;
  for (const p of points) {
    const s = sampleAt(sim, p.t - shiftSec);
    const ex = s.x - p.x;
    const ey = s.y - p.y;
    const d2 = ex * ex + ey * ey;
    sum += d2;
    dx += ex;
    dy += ey;
    max = Math.max(max, Math.sqrt(d2));
  }
  const n = points.length;
  return { points: n, rmsCm: Math.sqrt(sum / n), meanOffsetCm: { x: dx / n, y: dy / n }, maxCm: max };
}

export function segmentReport(sim: Trajectory, segments: MeasuredSegments, shiftSec = 0): SegmentReport {
  return {
    ramp: segmentError(sim, segments.ramp, shiftSec),
    flight: segmentError(sim, segments.flight, shiftSec),
    bounce: segmentError(sim, segments.bounce, shiftSec),
    roll: segmentError(sim, segments.roll, shiftSec),
  };
}
