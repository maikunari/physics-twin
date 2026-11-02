import type { Vec2, WorldScene } from '../scene/calibration';

/** A point on a ball path, t in seconds on the measured clock (from the detected release), x and y in world cm. */
export interface PathPoint {
  readonly t: number;
  readonly x: number;
  readonly y: number;
}

/**
 * What a prediction commits to: the first of these to happen after the freeze.
 *
 * - `touchdown`: the ball comes down onto the table after being off it (the
 *   landing off the ramp, or a bounce);
 * - `turnaround`: the ball stops going one way along the table and comes
 *   back (it hit the block, or rolled up a slope and back);
 * - `horizon`: neither happened before the prediction's horizon, so the
 *   prediction is where the ball is at the horizon.
 *
 * On the lead scene the ball usually lands off the ramp inside the first
 * second, so the committed event is most often the block hit.
 */
export type EventKind = 'touchdown' | 'turnaround' | 'horizon';
export const EVENT_KINDS: readonly EventKind[] = ['touchdown', 'turnaround', 'horizon'];

export interface PathEvent extends PathPoint {
  readonly kind: EventKind;
}

/**
 * Height bands for "off the table" and "on it", cm above resting height. The
 * gap between them stops tracker jitter from reading as a bounce; the lower
 * one matches the fit's segment split.
 */
const LIFT_CM = 0.5;
const TOUCH_CM = 0.25;
/** The ball has turned around once it is this far back from its furthest point, cm. Well above tracker jitter. */
const TURNAROUND_CM = 1;
/** The direction of travel at the freeze is read over this much of the path before it, s. */
const HEADING_SEC = 0.05;

/** The direction the ball travels along the table at `atSec`: +1, −1, or 0 if it is not moving along it. */
function heading(path: readonly PathPoint[], atSec: number): number {
  const before = path.filter((p) => p.t <= atSec && p.t >= atSec - HEADING_SEC);
  const first = before[0];
  const last = before.at(-1);
  if (!first || !last || last === first) return 0;
  const dx = last.x - first.x;
  return Math.abs(dx) < 0.05 ? 0 : Math.sign(dx);
}

function firstTouchdown(path: readonly PathPoint[], world: WorldScene, fromSec: number, untilSec: number): PathEvent | null {
  const rest = world.ball.radius;
  // Followed from the start of the path, so a ball in the air at the freeze lands after it.
  let airborne = false;
  for (const p of path) {
    if (p.t > untilSec) break;
    const high = p.y > rest + LIFT_CM;
    const low = p.y <= rest + TOUCH_CM;
    if (p.t > fromSec && airborne && low) return { kind: 'touchdown', t: p.t, x: p.x, y: p.y };
    if (high) airborne = true;
    else if (low) airborne = false;
  }
  return null;
}

function firstTurnaround(path: readonly PathPoint[], fromSec: number, untilSec: number): PathEvent | null {
  let dir = heading(path, fromSec);
  let extreme: PathPoint | null = null;
  for (const p of path) {
    if (p.t <= fromSec) continue;
    if (p.t > untilSec) break;
    if (!extreme) {
      extreme = p;
      continue;
    }
    if (dir === 0) {
      // Not moving along the table at the freeze: the first clear move sets the heading.
      if (Math.abs(p.x - extreme.x) >= TURNAROUND_CM) {
        dir = Math.sign(p.x - extreme.x);
        extreme = p;
      }
      continue;
    }
    if ((p.x - extreme.x) * dir > 0) extreme = p;
    else if ((extreme.x - p.x) * dir >= TURNAROUND_CM) return { kind: 'turnaround', t: extreme.t, x: extreme.x, y: extreme.y };
  }
  return null;
}

/**
 * The ball's position at time `t`, linearly interpolated between the two
 * points around it. Null if the path does not reach `t` or has a gap there
 * longer than `maxGapSec` (the tracker lost the ball).
 */
export function positionAt(path: readonly PathPoint[], t: number, maxGapSec = Number.POSITIVE_INFINITY): PathPoint | null {
  const after = path.findIndex((p) => p.t >= t);
  if (after < 0) return null;
  const b = path[after];
  if (!b) return null;
  if (b.t === t) return b;
  const a = path[after - 1];
  if (!a || b.t - a.t > maxGapSec) return null;
  const f = (t - a.t) / (b.t - a.t);
  return { t, x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
}

/**
 * The first event of `kind` on the path in (fromSec, untilSec], or null if
 * it did not happen there. For `horizon` it is the position at `untilSec`.
 * The same detector reads the simulation and the measured track, so the two
 * are compared like for like.
 */
export function findEvent(
  path: readonly PathPoint[],
  world: WorldScene,
  kind: EventKind,
  fromSec: number,
  untilSec: number,
  maxGapSec?: number,
): PathEvent | null {
  if (kind === 'touchdown') return firstTouchdown(path, world, fromSec, untilSec);
  if (kind === 'turnaround') return firstTurnaround(path, fromSec, untilSec);
  const at = positionAt(path, untilSec, maxGapSec);
  return at ? { kind: 'horizon', ...at } : null;
}

/** The first touchdown or turnaround after `fromSec`, else the position at `untilSec`. */
export function firstEvent(path: readonly PathPoint[], world: WorldScene, fromSec: number, untilSec: number): PathEvent | null {
  const touchdown = firstTouchdown(path, world, fromSec, untilSec);
  const turnaround = firstTurnaround(path, fromSec, untilSec);
  if (touchdown && turnaround) return touchdown.t <= turnaround.t ? touchdown : turnaround;
  return touchdown ?? turnaround ?? findEvent(path, world, 'horizon', fromSec, untilSec);
}

/** Distance between two world points, cm. */
export const distanceCm = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.y - b.y);
