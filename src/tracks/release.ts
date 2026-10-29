import type { TrajectoryPoint } from './trajectories';

/** The resting position is the median of this many leading points, so one bad box cannot move it. */
const REST_POINTS = 5;
/** Moves smaller than this from the resting position are tracker jitter, not motion, cm. */
const REST_CM = 0.3;
/** The ball is certainly rolling once it is this far from rest, cm. */
const MOVING_CM = 1;
/** By default the start of the motion is fitted over this much travel, cm. */
const DEFAULT_FIT_UNTIL_CM = 8;
const MIN_FIT_POINTS = 4;

const median = (values: readonly number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? (sorted[mid] ?? 0) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
};

/**
 * When the ball was let go, in clip seconds. The filming guide has Mike wait
 * a second before releasing, so the simulation has to start there rather
 * than at frame 0.
 *
 * From rest under constant acceleration, distance travelled is ½·a·(t − t0)²,
 * so √distance is a straight line in t that crosses zero at t0. The line is
 * fitted over the first `fitUntilCm` of travel, which must stay on the ramp,
 * where the acceleration is constant: the longer the run, the less tracker
 * noise moves t0. Returns null when the ball never clearly moves.
 */
export function detectReleaseTime(
  points: readonly TrajectoryPoint[],
  fitUntilCm: number = DEFAULT_FIT_UNTIL_CM,
): number | null {
  const head = points.slice(0, REST_POINTS);
  if (head.length === 0) return null;
  const rest = { x: median(head.map((p) => p.x)), y: median(head.map((p) => p.y)) };
  const dist = points.map((p) => Math.hypot(p.x - rest.x, p.y - rest.y));

  const moving = dist.findIndex((d) => d > MOVING_CM);
  if (moving < 0) return null;
  // The moving run: back from the first clearly moving point while still off rest, forward until the fit range ends.
  let first = moving;
  while (first > 0 && (dist[first - 1] ?? 0) > REST_CM) first--;
  let last = moving;
  while (last + 1 < points.length && (dist[last + 1] ?? Infinity) <= fitUntilCm) last++;

  const fit = points.slice(first, last + 1).map((p, i) => ({ t: p.t, r: Math.sqrt(dist[first + i] ?? 0) }));
  const lastRest = points[first - 1]?.t ?? points[0]?.t ?? 0;
  if (fit.length < MIN_FIT_POINTS) return lastRest;

  const n = fit.length;
  const mt = fit.reduce((s, p) => s + p.t, 0) / n;
  const mr = fit.reduce((s, p) => s + p.r, 0) / n;
  let sxy = 0;
  let sxx = 0;
  for (const p of fit) {
    sxy += (p.t - mt) * (p.r - mr);
    sxx += (p.t - mt) ** 2;
  }
  const slope = sxy / sxx;
  if (!(slope > 0)) return lastRest;
  // Never before the clip starts, never after the ball is first seen off rest.
  return Math.min(Math.max(mt - mr / slope, points[0]?.t ?? 0), fit[0]?.t ?? 0);
}
