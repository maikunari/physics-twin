import { beforeAll, describe, expect, it } from 'vitest';
import { calibrate, toWorldScene, type WorldScene } from '../scene/calibration';
import { FIXTURE_IMAGE_SIZE, FIXTURE_SCENE } from '../scene/fixtures';
import { DEFAULT_SIM_PARAMS, type SimParams } from './params';
import { createPrng } from './prng';
import { ballStart, buildSceneWorld, initRapier, simulateScene } from './sceneWorld';

const scene = toWorldScene(FIXTURE_SCENE, calibrate(FIXTURE_SCENE, FIXTURE_IMAGE_SIZE));
const G_CM = 981;

/** Parameters drawn from a seed, the way the ensemble will sample them. */
function sampleParams(seed: number): SimParams {
  const r = createPrng(seed);
  return {
    muRamp: 0.1 + 0.5 * r(),
    muTable: 0.1 + 0.5 * r(),
    restitution: 0.2 + 0.6 * r(),
    rollingDamping: r(),
    v0: 30 * r(),
    omega0: -5 * r(),
  };
}

beforeAll(async () => {
  await initRapier();
});

describe('buildSceneWorld', () => {
  it('builds the ramp, the table, every block and the ball', () => {
    const built = buildSceneWorld(scene, DEFAULT_SIM_PARAMS);
    try {
      expect(built.world.colliders.len()).toBe(2 + scene.blocks.length + 1);
      expect([...built.colliders.blocks.keys()]).toEqual(scene.blocks.map((b) => b.id));
      const start = built.ballSample(0);
      expect(Math.hypot(start.x - scene.ball.center.x, start.y - scene.ball.center.y)).toBeLessThan(scene.ball.radius);
    } finally {
      built.free();
    }
  });

  it('leaves out omitted blocks', () => {
    const built = buildSceneWorld(scene, DEFAULT_SIM_PARAMS, { omitBlockIds: ['blue'] });
    try {
      expect(built.colliders.blocks.size).toBe(0);
      expect(built.world.colliders.len()).toBe(3);
    } finally {
      built.free();
    }
  });

  it('applies friction and restitution from the parameters', () => {
    const params: SimParams = { ...DEFAULT_SIM_PARAMS, muRamp: 0.11, muTable: 0.22, restitution: 0.66 };
    const built = buildSceneWorld(scene, params);
    try {
      const collider = (h: number) => built.world.getCollider(h);
      expect(collider(built.colliders.ramp).friction()).toBeCloseTo(0.11);
      expect(collider(built.colliders.table).friction()).toBeCloseTo(0.22);
      expect(collider(built.colliders.blocks.get('blue')!).friction()).toBeCloseTo(0.22);
      expect(collider(built.colliders.ball).restitution()).toBeCloseTo(0.66);
    } finally {
      built.free();
    }
  });
});

describe('ballStart', () => {
  /** Signed distance of a point above the ramp line, cm. */
  const heightAboveRamp = (p: { x: number; y: number }) => {
    const { top, bottom } = scene.ramp;
    const dx = bottom.x - top.x;
    const dy = bottom.y - top.y;
    return ((p.x - top.x) * -dy + (p.y - top.y) * dx) / Math.hypot(dx, dy) * Math.sign(dx);
  };

  it('settles a ball grounded slightly off the ramp onto its surface', () => {
    expect(Math.abs(heightAboveRamp(scene.ball.center) - scene.ball.radius)).toBeGreaterThan(0.01);
    expect(heightAboveRamp(ballStart(scene))).toBeCloseTo(scene.ball.radius, 9);
    for (const dy of [-0.5, 0.5]) {
      const nudged = { ...scene, ball: { ...scene.ball, center: { x: scene.ball.center.x, y: scene.ball.center.y + dy } } };
      expect(heightAboveRamp(ballStart(nudged))).toBeCloseTo(scene.ball.radius, 9);
    }
  });

  it('leaves a ball that is clearly not on the ramp where it is', () => {
    const above = { ...scene, ball: { ...scene.ball, center: { x: 20, y: 60 } } };
    expect(ballStart(above)).toEqual({ x: 20, y: 60 });
    const beyond = { ...scene, ball: { ...scene.ball, center: { x: 100, y: 1.7 } } };
    expect(ballStart(beyond)).toEqual({ x: 100, y: 1.7 });
  });

  it('is where the simulated ball starts', () => {
    const { samples } = simulateScene(scene, DEFAULT_SIM_PARAMS, { durationSec: 0 });
    expect(samples[0]!.x).toBeCloseTo(ballStart(scene).x, 4);
    expect(samples[0]!.y).toBeCloseTo(ballStart(scene).y, 4);
  });
});

describe('simulateScene', () => {
  it('is deterministic: two runs from the same seed are identical', () => {
    const params = sampleParams(42);
    const a = simulateScene(scene, params, { durationSec: 2 });
    const b = simulateScene(scene, params, { durationSec: 2 });
    expect(a.samples).toHaveLength(481);
    expect(b.samples).toEqual(a.samples);
  });

  it('changes when the seed changes', () => {
    const a = simulateScene(scene, sampleParams(1), { durationSec: 1 });
    const b = simulateScene(scene, sampleParams(2), { durationSec: 1 });
    expect(b.samples.at(-1)).not.toEqual(a.samples.at(-1));
  });

  it('works in centimetres: a ball clear of every surface falls ½·g·t²', () => {
    const clear: WorldScene = { ...scene, ball: { ...scene.ball, center: { x: -50, y: 40 } } };
    const { samples } = simulateScene(clear, DEFAULT_SIM_PARAMS, { durationSec: 0.25 });
    const end = samples.at(-1)!;
    expect(end.x).toBeCloseTo(-50, 6);
    // Semi-implicit Euler is a step ahead of the exact curve: within 1% at 60 steps.
    expect(40 - end.y).toBeCloseTo(0.5 * G_CM * 0.25 ** 2, -0.5);
  });

  it('rolls a solid ball down the ramp at 5/7·g·sinθ when friction holds', () => {
    const grip: SimParams = { ...DEFAULT_SIM_PARAMS, muRamp: 1, rollingDamping: 0 };
    const t = 0.2;
    const { samples } = simulateScene(scene, grip, { durationSec: t });
    const d = { x: scene.ramp.bottom.x - scene.ramp.top.x, y: scene.ramp.bottom.y - scene.ramp.top.y };
    const len = Math.hypot(d.x, d.y);
    const sinTheta = -d.y / len;
    const a = samples[0]!;
    const b = samples.at(-1)!;
    const travelled = ((b.x - a.x) * d.x + (b.y - a.y) * d.y) / len;
    const expected = 0.5 * (5 / 7) * G_CM * sinTheta * t * t;
    expect(Math.abs(travelled - expected) / expected).toBeLessThan(0.03);
    // A disc's inertia would give 2/3 instead: 7% short, outside this tolerance.
    const disc = 0.5 * (2 / 3) * G_CM * sinTheta * t * t;
    expect(Math.abs(travelled - disc) / disc).toBeGreaterThan(0.05);
  });

  it('a hollow ball rolls slower than a solid one', () => {
    const grip: SimParams = { ...DEFAULT_SIM_PARAMS, muRamp: 1, rollingDamping: 0 };
    const solid = simulateScene(scene, grip, { durationSec: 0.3 }).samples.at(-1)!;
    const hollow = simulateScene(scene, grip, { durationSec: 0.3, ballKind: 'hollow' }).samples.at(-1)!;
    expect(hollow.x).toBeLessThan(solid.x);
  });

  it('rolls the ball down the ramp and onto the table without tunnelling', () => {
    const { samples } = simulateScene(scene, DEFAULT_SIM_PARAMS, { durationSec: 2 });
    const end = samples.at(-1)!;
    expect(end.x).toBeGreaterThan(scene.ramp.bottom.x);
    // Resting on (or rolling along) the table line, never below it.
    for (const s of samples) expect(s.y).toBeGreaterThan(scene.table.left.y - scene.ball.radius * 0.5);
    expect(end.y).toBeCloseTo(scene.table.left.y + scene.ball.radius, 0);
  });

  it('a removed block no longer stops the ball', () => {
    const fast: SimParams = { ...DEFAULT_SIM_PARAMS, muTable: 0.05, rollingDamping: 0, v0: 100 };
    const withBlock = simulateScene(scene, fast, { durationSec: 3 });
    const without = simulateScene(scene, fast, { durationSec: 3, omitBlockIds: ['blue'] });
    const block = scene.blocks[0]!;
    expect(withBlock.samples.at(-1)!.x).toBeLessThan(block.center.x);
    expect(without.samples.at(-1)!.x).toBeGreaterThan(withBlock.samples.at(-1)!.x);
  });
});
