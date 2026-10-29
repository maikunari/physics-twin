import type { WorldScene } from '../scene/calibration';
import type { Trajectory, TrajectorySample } from '../sim/sceneWorld';
import type { TrajectoryPoint } from '../tracks/trajectories';

/** The simulated ball at time `t`, linearly interpolated between steps; clamps to the ends. */
export function sampleAt(sim: Trajectory, t: number): TrajectorySample {
  const { samples, dt } = sim;
  const first = samples[0];
  const last = samples.at(-1);
  if (!first || !last) throw new Error('empty trajectory');
  if (t <= first.t) return first;
  if (t >= last.t) return last;
  const i = Math.floor(t / dt);
  const a = samples[i] ?? last;
  const b = samples[i + 1] ?? last;
  const f = (t - a.t) / dt;
  return { t, x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, angle: a.angle + (b.angle - a.angle) * f };
}

/** Root-mean-square distance between the simulation and the measured points, cm. NaN with no points. */
export function rmsCm(sim: Trajectory, points: readonly TrajectoryPoint[]): number {
  if (points.length === 0) return Number.NaN;
  let sum = 0;
  for (const p of points) {
    const s = sampleAt(sim, p.t);
    sum += (s.x - p.x) ** 2 + (s.y - p.y) ** 2;
  }
  return Math.sqrt(sum / points.length);
}

/** Only the points the fitter may see: those at or before the freeze time (spec §5, fit on 0–1.0 s). */
export function withinWindow(points: readonly TrajectoryPoint[], windowEndSec: number): TrajectoryPoint[] {
  return points.filter((p) => p.t <= windowEndSec);
}

export interface Segments {
  /** The ball on the ramp: its centre has not passed the ramp's low end. */
  readonly ramp: readonly TrajectoryPoint[];
  /** Everything after: leaving the ramp, flight, bounces and roll. */
  readonly after: readonly TrajectoryPoint[];
}

/**
 * Splits a measured path where the ball leaves the ramp. The two segments
 * carry different parameters: friction on the ramp sets how fast the ball
 * comes down it, restitution sets the bounces after it.
 */
export function splitAtRampEnd(points: readonly TrajectoryPoint[], scene: WorldScene): Segments {
  const end = scene.ramp.bottom.x;
  // The ramp may run either way across the frame.
  const dir = Math.sign(scene.ramp.bottom.x - scene.ramp.top.x) || 1;
  const index = points.findIndex((p) => (p.x - end) * dir > 0);
  return index < 0 ? { ramp: points, after: [] } : { ramp: points.slice(0, index), after: points.slice(index) };
}
