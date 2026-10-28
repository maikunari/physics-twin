import RAPIER from '@dimforge/rapier2d-compat';
import type { Vec2, WorldScene } from '../scene/calibration';
import { BALL_INERTIA_FACTOR, type BallKind, type SimParams } from './params';

/** Matches the 240 fps capture, so every simulated step lines up with a video frame. */
export const DEFAULT_DT = 1 / 240;
/**
 * Rapier runs in metres, the unit its solver tolerances are tuned for; every
 * input and output of this module is in centimetres and converts here.
 */
const M_PER_CM = 0.01;
const GRAVITY_M = { x: 0, y: -9.81 };
/** Static surfaces are slabs this thick under their line, so a fast ball cannot tunnel through a zero-width segment. */
const SURFACE_THICKNESS_CM = 2;
/** The ball's mass only scales its inertia here (every other body is fixed), so any positive value works. */
const BALL_MASS_KG = 1;

let ready: Promise<void> | null = null;

/** Loads Rapier's inlined WASM once. Safe to call repeatedly. */
export function initRapier(): Promise<void> {
  ready ??= RAPIER.init();
  return ready;
}

/** One simulated step, in the world frame's centimetres. */
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

export interface WorldOptions {
  readonly dt?: number;
  /** Block ids to leave out (the "remove block" what-if). */
  readonly omitBlockIds?: readonly string[];
  /** Sets the ball's moment of inertia; defaults to a solid ball (marble, golf ball). */
  readonly ballKind?: BallKind;
}

export interface SimOptions extends WorldOptions {
  readonly durationSec: number;
}

/** A built Rapier world for one scene. Call `free()` when done; the WASM memory is not garbage collected. */
export interface SceneWorld {
  readonly world: RAPIER.World;
  readonly ball: RAPIER.RigidBody;
  /** Collider handles by role, so tests and the overlay can tell the bodies apart. */
  readonly colliders: {
    readonly ramp: number;
    readonly table: number;
    readonly blocks: ReadonlyMap<string, number>;
    readonly ball: number;
  };
  /** The ball's position and rotation now, in centimetres. */
  ballSample(t: number): TrajectorySample;
  free(): void;
}

const toM = (v: Vec2) => ({ x: v.x * M_PER_CM, y: v.y * M_PER_CM });

/** A fixed slab whose top face runs along the line from `a` to `b` (centimetres). Returns the collider handle. */
function addSurface(world: RAPIER.World, a: Vec2, b: Vec2, friction: number): number {
  const am = toM(a);
  const bm = toM(b);
  const dx = bm.x - am.x;
  const dy = bm.y - am.y;
  const length = Math.hypot(dx, dy);
  // Unit normal on the "up" side of the line, used to sink the slab beneath it.
  let nx = -dy / length;
  let ny = dx / length;
  if (ny < 0) {
    nx = -nx;
    ny = -ny;
  }
  const half = (SURFACE_THICKNESS_CM * M_PER_CM) / 2;
  const body = world.createRigidBody(
    RAPIER.RigidBodyDesc.fixed()
      .setTranslation((am.x + bm.x) / 2 - nx * half, (am.y + bm.y) / 2 - ny * half)
      .setRotation(Math.atan2(dy, dx)),
  );
  return world.createCollider(RAPIER.ColliderDesc.cuboid(length / 2, half).setFriction(friction).setRestitution(0), body)
    .handle;
}

/**
 * Builds the Rapier world for a scene: the ramp and table as fixed slabs, each
 * block as a fixed box on the table, and the ball as a dynamic body at its
 * frame-0 position with the initial speed and spin from `params`.
 *
 * Friction and restitution come from `params`: the ball's combine rules make
 * every contact use the surface's friction and the ball's restitution.
 */
export function buildSceneWorld(scene: WorldScene, params: SimParams, options: WorldOptions = {}): SceneWorld {
  const omit = new Set(options.omitBlockIds);
  const world = new RAPIER.World(GRAVITY_M);
  world.timestep = options.dt ?? DEFAULT_DT;

  const ramp = addSurface(world, scene.ramp.top, scene.ramp.bottom, params.muRamp);
  const table = addSurface(world, scene.table.left, scene.table.right, params.muTable);
  const blocks = new Map<string, number>();
  for (const block of scene.blocks) {
    if (omit.has(block.id)) continue;
    const c = toM(block.center);
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(c.x, c.y));
    const collider = world.createCollider(
      RAPIER.ColliderDesc.cuboid(block.halfExtents.x * M_PER_CM, block.halfExtents.y * M_PER_CM).setFriction(
        params.muTable,
      ),
      body,
    );
    blocks.set(block.id, collider.handle);
  }

  const down = { x: scene.ramp.bottom.x - scene.ramp.top.x, y: scene.ramp.bottom.y - scene.ramp.top.y };
  const downLen = Math.hypot(down.x, down.y);
  const start = toM(scene.ball.center);
  const v0 = params.v0 * M_PER_CM;
  const ball = world.createRigidBody(
    RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(start.x, start.y)
      .setLinvel((v0 * down.x) / downLen, (v0 * down.y) / downLen)
      .setAngvel(params.omega0)
      .setAngularDamping(params.rollingDamping)
      .setCcdEnabled(true),
  );
  const radius = scene.ball.radius * M_PER_CM;
  const inertia = BALL_INERTIA_FACTOR[options.ballKind ?? 'solid'] * BALL_MASS_KG * radius * radius;
  const ballCollider = world.createCollider(
    RAPIER.ColliderDesc.ball(radius)
      .setMassProperties(BALL_MASS_KG, { x: 0, y: 0 }, inertia)
      .setFriction(1)
      .setFrictionCombineRule(RAPIER.CoefficientCombineRule.Min)
      .setRestitution(params.restitution)
      .setRestitutionCombineRule(RAPIER.CoefficientCombineRule.Max),
    ball,
  );

  return {
    world,
    ball,
    colliders: { ramp, table, blocks, ball: ballCollider.handle },
    ballSample: (t) => {
      const p = ball.translation();
      return { t, x: p.x / M_PER_CM, y: p.y / M_PER_CM, angle: ball.rotation() };
    },
    free: () => world.free(),
  };
}

/**
 * Runs the scene once and records the ball every step. A fresh Rapier world
 * is built and freed on every call, so identical inputs give bit-identical
 * trajectories.
 */
export function simulateScene(scene: WorldScene, params: SimParams, options: SimOptions): Trajectory {
  const dt = options.dt ?? DEFAULT_DT;
  const steps = Math.round(options.durationSec / dt);
  const built = buildSceneWorld(scene, params, { ...options, dt });
  try {
    const samples: TrajectorySample[] = [built.ballSample(0)];
    for (let i = 1; i <= steps; i++) {
      built.world.step();
      samples.push(built.ballSample(i * dt));
    }
    return { dt, samples };
  } finally {
    built.free();
  }
}
