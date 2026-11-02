import { describe, expect, it } from 'vitest';
import type { WorldScene } from '../scene/calibration';
import type { Trajectory } from '../sim/sceneWorld';
import type { TrajectoryPoint } from '../tracks/trajectories';
import { segmentError, splitSegments } from './segments';

/** A ramp from (0, 20) down to (20, 5), the table at y = 0, a 1 cm ball. */
const scene: WorldScene = {
  ramp: { top: { x: 0, y: 20 }, bottom: { x: 20, y: 5 } },
  table: { left: { x: -10, y: 0 }, right: { x: 100, y: 0 } },
  blocks: [],
  ball: { center: { x: 1, y: 21 }, radius: 1 },
};

const point = (t: number, x: number, y: number): TrajectoryPoint => ({
  frame: Math.round(t * 240),
  t,
  x,
  y,
  px: { x: 0, y: 0 },
  confidence: 0.9,
});

describe('splitSegments', () => {
  const path = [
    point(0.0, 2, 20),
    point(0.1, 10, 14),
    point(0.2, 19, 7), // still on the ramp
    point(0.3, 24, 4), // in the air
    point(0.35, 27, 1.1), // first touch
    point(0.4, 30, 2.5), // bounced up
    point(0.45, 33, 1.05), // down again
    point(0.5, 35, 1.0),
    point(0.55, 37, 1.02),
  ];

  it('splits ramp, flight, bounce and roll from the measured heights', () => {
    const s = splitSegments(path, scene);
    expect(s.ramp.map((p) => p.t)).toEqual([0, 0.1, 0.2]);
    expect(s.flight.map((p) => p.t)).toEqual([0.3]);
    expect(s.bounce.map((p) => p.t)).toEqual([0.35, 0.4]);
    expect(s.roll.map((p) => p.t)).toEqual([0.45, 0.5, 0.55]);
  });

  it('leaves the segments the window never reached empty', () => {
    const s = splitSegments(path.slice(0, 4), scene);
    expect(s.flight).toHaveLength(1);
    expect(s.bounce).toEqual([]);
    expect(s.roll).toEqual([]);
  });

  it('calls a window that ends in the air a bounce, not a roll', () => {
    const s = splitSegments(path.slice(0, 6), scene);
    expect(s.bounce.map((p) => p.t)).toEqual([0.35, 0.4]);
    expect(s.roll).toEqual([]);
  });
});

describe('segmentError', () => {
  const sim: Trajectory = {
    dt: 0.1,
    samples: [0, 1, 2, 3].map((i) => ({ t: i * 0.1, x: i + 0.5, y: 2, angle: 0 })),
  };

  it('reports RMS, the signed mean offset (simulated minus measured) and the largest miss', () => {
    const e = segmentError(sim, [point(0, 0, 2), point(0.1, 1, 1), point(0.2, 2, 2)]);
    expect(e?.points).toBe(3);
    expect(e?.meanOffsetCm.x).toBeCloseTo(0.5);
    expect(e?.meanOffsetCm.y).toBeCloseTo(1 / 3);
    expect(e?.maxCm).toBeCloseTo(Math.hypot(0.5, 1));
    expect(e?.rmsCm).toBeCloseTo(Math.sqrt((0.25 + 1.25 + 0.25) / 3));
  });

  it('is null for an empty segment', () => {
    expect(segmentError(sim, [])).toBeNull();
  });
});
