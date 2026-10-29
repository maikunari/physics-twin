import { describe, expect, it } from 'vitest';
import type { WorldScene } from '../scene/calibration';
import type { Trajectory } from '../sim/sceneWorld';
import type { TrajectoryPoint } from '../tracks/trajectories';
import { rmsCm, sampleAt, splitAtRampEnd, withinWindow } from './score';

const sim: Trajectory = {
  dt: 0.1,
  samples: [0, 1, 2, 3].map((i) => ({ t: i * 0.1, x: 10 * i, y: -i, angle: i })),
};

const point = (t: number, x: number, y: number): TrajectoryPoint => ({
  frame: Math.round(t * 240),
  t,
  x,
  y,
  px: { x: 0, y: 0 },
  confidence: 0.9,
});

describe('sampleAt', () => {
  it('interpolates between steps and clamps outside the run', () => {
    expect(sampleAt(sim, 0.15)).toMatchObject({ x: 15, y: -1.5 });
    expect(sampleAt(sim, 0.2)).toMatchObject({ x: 20 });
    expect(sampleAt(sim, -1)).toBe(sim.samples[0]);
    expect(sampleAt(sim, 9)).toBe(sim.samples[3]);
  });

  it('throws on an empty trajectory', () => {
    expect(() => sampleAt({ dt: 0.1, samples: [] }, 0)).toThrow(/empty/);
  });
});

describe('rmsCm', () => {
  it('is zero on the simulation itself and the root-mean-square distance otherwise', () => {
    expect(rmsCm(sim, sim.samples.map((s) => point(s.t, s.x, s.y)))).toBe(0);
    expect(rmsCm(sim, [point(0, 3, 4), point(0.1, 10, -1)])).toBeCloseTo(Math.sqrt(25 / 2));
  });

  it('is NaN with nothing to compare', () => {
    expect(rmsCm(sim, [])).toBeNaN();
  });
});

describe('withinWindow', () => {
  it('keeps points up to and including the freeze time', () => {
    const pts = [0.5, 1, 1 + 1 / 240, 2].map((t) => point(t, 0, 0));
    expect(withinWindow(pts, 1).map((p) => p.t)).toEqual([0.5, 1]);
  });
});

describe('splitAtRampEnd', () => {
  const rampScene = (top: number, bottom: number) =>
    ({ ramp: { top: { x: top, y: 20 }, bottom: { x: bottom, y: 5 } } }) as unknown as WorldScene;

  it('splits where the ball centre passes the ramp low end', () => {
    const pts = [10, 30, 39, 41, 60].map((x, i) => point(i / 240, x, 0));
    const { ramp, after } = splitAtRampEnd(pts, rampScene(0, 40));
    expect(ramp.map((p) => p.x)).toEqual([10, 30, 39]);
    expect(after.map((p) => p.x)).toEqual([41, 60]);
  });

  it('handles a ramp running right to left', () => {
    const pts = [90, 70, 61, 59, 40].map((x, i) => point(i / 240, x, 0));
    const { ramp, after } = splitAtRampEnd(pts, rampScene(100, 60));
    expect(ramp.map((p) => p.x)).toEqual([90, 70, 61]);
    expect(after.map((p) => p.x)).toEqual([59, 40]);
  });

  it('puts everything on the ramp when the ball never leaves it', () => {
    const pts = [1, 2].map((x, i) => point(i, x, 0));
    expect(splitAtRampEnd(pts, rampScene(0, 40))).toEqual({ ramp: pts, after: [] });
  });
});
