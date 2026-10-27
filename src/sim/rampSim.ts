import RAPIER from '@dimforge/rapier2d-compat';
import type { Vec2, WorldScene } from '../scene/calibration';
import type { SimParams } from './params';

/** Matches the 240 fps capture, so every simulated step lines up with a video frame. */
export const DEFAULT_DT = 1 / 240;
const GRAVITY = { x: 0, y: -9.81 };
/** Static surfaces are slabs this thick under their line, so a fast ball cannot tunnel through a zero-width segment. */
const SURFACE_THICKNESS_M = 0.02;

let ready: Promise<void> | null = null;

/** Loads Rapier's inlined WASM once. Safe to call repeatedly. */
export function initRapier(): Promise<void> {
  ready ??= RAPIER.init();
  return ready;
}

export interface TrajectorySample {
  readonly t: number;
  readonly x: number;
  readonly y: number;
  readonly angle: number;
}

export interface Trajectory {
  readonly dt: number;
  readonly samples: readonly TrajectorySample[];
}

export interface SimOptions {
  readonly durationSec: number;
  readonly dt?: number;
  /** Block ids to leave out (the "remove block" what-if). */
  readonly omitBlockIds?: readonly string[];
}

/** A fixed slab whose top face runs along the line from `a` to `b`. */
function addSurface(world: RAPIER.World, a: Vec2, b: Vec2, friction: number) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.hypot(dx, dy);
  const angle = Math.atan2(dy, dx);
  // Unit normal on the "up" side of the line, used to sink the slab beneath it.
  let nx = -dy / length;
  let ny = dx / length;
  if (ny < 0) {
    nx = -nx;
    ny = -ny;
  }
  const half = SURFACE_THICKNESS_M / 2;
  const body = world.createRigidBody(
    RAPIER.RigidBodyDesc.fixed()
      .setTranslation((a.x + b.x) / 2 - nx * half, (a.y + b.y) / 2 - ny * half)
      .setRotation(angle),
  );
  world.createCollider(RAPIER.ColliderDesc.cuboid(length / 2, half).setFriction(friction).setRestitution(0), body);
}

/**
 * Runs the ball-on-ramp scene once. A fresh Rapier world is built and freed on
 * every call, so identical inputs give bit-identical trajectories.
 */
export function simulateRamp(scene: WorldScene, params: SimParams, options: SimOptions): Trajectory {
  const dt = options.dt ?? DEFAULT_DT;
  const steps = Math.round(options.durationSec / dt);
  const omit = new Set(options.omitBlockIds);

  const world = new RAPIER.World(GRAVITY);
  try {
    world.timestep = dt;

    addSurface(world, scene.ramp.top, scene.ramp.bottom, params.muRamp);
    addSurface(world, scene.table.left, scene.table.right, params.muTable);
    for (const block of scene.blocks) {
      if (omit.has(block.id)) continue;
      const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(block.center.x, block.center.y));
      world.createCollider(
        RAPIER.ColliderDesc.cuboid(block.halfExtents.x, block.halfExtents.y).setFriction(params.muTable),
        body,
      );
    }

    const down = {
      x: scene.ramp.bottom.x - scene.ramp.top.x,
      y: scene.ramp.bottom.y - scene.ramp.top.y,
    };
    const downLen = Math.hypot(down.x, down.y);
    const ball = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(scene.ball.center.x, scene.ball.center.y)
        .setLinvel((params.v0 * down.x) / downLen, (params.v0 * down.y) / downLen)
        .setAngvel(params.omega0)
        .setAngularDamping(params.rollingDamping)
        .setCcdEnabled(true),
    );
    // The ball's combine rules make each contact use the surface's friction and the ball's restitution.
    world.createCollider(
      RAPIER.ColliderDesc.ball(scene.ball.radius)
        .setFriction(1)
        .setFrictionCombineRule(RAPIER.CoefficientCombineRule.Min)
        .setRestitution(params.restitution)
        .setRestitutionCombineRule(RAPIER.CoefficientCombineRule.Max),
      ball,
    );

    const samples: TrajectorySample[] = [];
    const record = (i: number) => {
      const p = ball.translation();
      samples.push({ t: i * dt, x: p.x, y: p.y, angle: ball.rotation() });
    };
    record(0);
    for (let i = 1; i <= steps; i++) {
      world.step();
      record(i);
    }
    return { dt, samples };
  } finally {
    world.free();
  }
}
