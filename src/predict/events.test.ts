import { describe, expect, it } from 'vitest';
import type { WorldScene } from '../scene/calibration';
import { findEvent, firstEvent, positionAt, type PathPoint } from './events';

const R = 1;
const world: WorldScene = {
  ramp: { top: { x: 0, y: 20 }, bottom: { x: 20, y: 5 } },
  table: { left: { x: 0, y: 0 }, right: { x: 150, y: 0 } },
  blocks: [],
  ball: { center: { x: 1, y: 21 }, radius: R },
};
const FREEZE = 1;
const HORIZON = 2;

/** A path sampled at 240 fps from a function of time. */
function path(fn: (t: number) => { x: number; y: number }, until = HORIZON + 0.1): PathPoint[] {
  return Array.from({ length: Math.round(until * 240) + 1 }, (_, i) => ({ t: i / 240, ...fn(i / 240) }));
}

describe('touchdown', () => {
  it('finds the first landing after the freeze', () => {
    // Rolling on the table, a hop from 1.1 s to 1.25 s.
    const p = path((t) => ({ x: 50 + 100 * t, y: t > 1.1 && t < 1.25 ? R + 2 : R }));
    const e = findEvent(p, world, 'touchdown', FREEZE, HORIZON);
    expect(e?.kind).toBe('touchdown');
    expect(e?.t).toBeCloseTo(1.25, 2);
  });

  it('counts a ball still in the air at the freeze', () => {
    const p = path((t) => ({ x: 30 + 100 * t, y: t < 1.05 ? R + 3 : R }));
    expect(findEvent(p, world, 'touchdown', FREEZE, HORIZON)?.t).toBeCloseTo(1.05, 2);
  });

  it('does not count a landing before the freeze, or tracker jitter on the table', () => {
    const p = path((t) => ({ x: 30 + 100 * t, y: t < 0.8 ? R + 3 : R + 0.2 * Math.sin(t * 400) }));
    expect(findEvent(p, world, 'touchdown', FREEZE, HORIZON)).toBeNull();
  });
});

describe('turnaround', () => {
  it('finds the furthest point before the ball comes back', () => {
    const p = path((t) => ({ x: t < 1.3 ? 50 + 100 * t : 180 - 60 * (t - 1.3), y: R }));
    const e = findEvent(p, world, 'turnaround', FREEZE, HORIZON);
    expect(e?.kind).toBe('turnaround');
    expect(e?.t).toBeCloseTo(1.3, 2);
    expect(e?.x).toBeCloseTo(180, 0);
  });

  it('ignores jitter smaller than a centimetre', () => {
    const p = path((t) => ({ x: 120 + (t > 1 ? 0.4 * Math.sin(t * 300) : 100 * t), y: R }));
    expect(findEvent(p, world, 'turnaround', FREEZE, HORIZON)).toBeNull();
  });

  it('works for a ball travelling right to left', () => {
    const p = path((t) => ({ x: t < 1.4 ? 150 - 50 * t : 80 + 30 * (t - 1.4), y: R }));
    expect(findEvent(p, world, 'turnaround', FREEZE, HORIZON)?.t).toBeCloseTo(1.4, 2);
  });
});

describe('firstEvent', () => {
  it('takes whichever event comes first', () => {
    const p = path((t) => ({ x: t < 1.6 ? 50 + 100 * t : 210 - 50 * (t - 1.6), y: t > 1.1 && t < 1.2 ? R + 2 : R }));
    expect(firstEvent(p, world, FREEZE, HORIZON)?.kind).toBe('touchdown');
  });

  it('falls back to the position at the horizon', () => {
    const p = path((t) => ({ x: 50 + 10 * t, y: R }));
    const e = firstEvent(p, world, FREEZE, HORIZON);
    expect(e).toMatchObject({ kind: 'horizon', t: HORIZON });
    expect(e?.x).toBeCloseTo(70, 6);
  });
});

describe('positionAt', () => {
  const p: PathPoint[] = [
    { t: 0, x: 0, y: 0 },
    { t: 1, x: 10, y: 2 },
    { t: 3, x: 30, y: 2 },
  ];

  it('interpolates between the points around t', () => {
    expect(positionAt(p, 0.5)).toEqual({ t: 0.5, x: 5, y: 1 });
    expect(positionAt(p, 1)).toEqual(p[1]);
  });

  it('is null past the end, before the start, or across a gap', () => {
    expect(positionAt(p, 3.5)).toBeNull();
    expect(positionAt(p, -1)).toBeNull();
    expect(positionAt(p, 2, 1.5)).toBeNull();
    expect(positionAt(p, 2, 2)?.x).toBeCloseTo(20);
  });
});
