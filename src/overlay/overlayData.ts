import { recordsOfKind, frameIndexOf, type SegmentationMaskRecord } from '@meta-sam/parser';
import { z } from 'zod';
import {
  calibrate,
  DEFAULT_MARKER_DISTANCE_CM,
  toWorldScene,
  worldToPixel,
  type Calibration,
  type Vec2,
  type WorldScene,
} from '../scene/calibration';
import { recoverMuAndRestitution, type Recovery } from '../fit/recover';
import { groundedSceneSchema } from '../scene/schema';
import type { SimParams } from '../sim/params';
import { ballStart, simulateScene, type Trajectory } from '../sim/sceneWorld';
import { detectReleaseTime } from '../tracks/release';
import { parseSamText, trackedObjectsFor } from '../tracks/samText';
import { tracksToTrajectories, type ObjectTrajectory, type TrajectoryPoint } from '../tracks/trajectories';

/** `scene.json` as `smoke-spark.ts` (and the synthetic clip script) write it. */
export const sceneFileSchema = z.object({
  imageSize: z.strictObject({ width: z.number().int().positive(), height: z.number().int().positive() }),
  markerDistanceCm: z.number().positive().optional(),
  scene: groundedSceneSchema,
});

/** A trail breaks where the tracker lost the object for longer than this, frames. */
const TRAIL_GAP_FRAMES = 12;
/** The simulation runs this long past the last tracked frame, s. */
const SIM_TAIL_SEC = 0.5;
const MAX_SIM_SEC = 6;
/** Share of the ramp run the release fit may use. */
const RELEASE_FIT_SHARE = 0.8;

/** Everything the overlay draws for one clip, in source pixels or convertible to them. */
export interface OverlayData {
  readonly calibration: Calibration;
  readonly world: WorldScene;
  readonly fps: number;
  readonly trajectories: readonly ObjectTrajectory[];
  /** SAM masks by frame, at most one per object. */
  readonly masks: ReadonlyMap<number, readonly SegmentationMaskRecord[]>;
  /** Parser diagnostics that dropped data (malformed lines, bad masks). */
  readonly droppedRecords: number;
  /** Clip time when the ball was let go: the simulation's t = 0. */
  readonly releaseSec: number;
  readonly params: SimParams;
  readonly sim: Trajectory;
}

export interface OverlayInputs {
  readonly sceneJson: string;
  readonly samText: string;
  readonly fps: number;
  readonly params: SimParams;
  /** Overrides the tape-mark distance recorded in scene.json. */
  readonly markerDistanceCm?: number;
}

export function masksByFrame(records: Parameters<typeof recordsOfKind>[0]): Map<number, SegmentationMaskRecord[]> {
  const byFrame = new Map<number, SegmentationMaskRecord[]>();
  for (const mask of recordsOfKind(records, 'mask')) {
    const frame = frameIndexOf(mask);
    if (frame === undefined) continue;
    const list = byFrame.get(frame) ?? [];
    if (!list.some((m) => m.objectId === mask.objectId)) list.push(mask);
    byFrame.set(frame, list);
  }
  return byFrame;
}

/** The ball's measured points with t measured from the release, dropping any before it. */
export function sinceRelease(points: readonly TrajectoryPoint[], releaseSec: number): TrajectoryPoint[] {
  return points.filter((p) => p.t >= releaseSec).map((p) => ({ ...p, t: p.t - releaseSec }));
}

export function ballTrajectory(data: Pick<OverlayData, 'trajectories'>): ObjectTrajectory | undefined {
  return data.trajectories.find((t) => t.object.kind === 'ball');
}

/** Re-runs the simulation for new parameters, keeping everything measured. */
export function withParams(data: OverlayData, params: SimParams): OverlayData {
  const durationSec = (data.sim.samples.length - 1) * data.sim.dt;
  return { ...data, params, sim: simulateScene(data.world, params, { durationSec }) };
}

/**
 * Fits μ_ramp and e to the ball's first second after release (the day-2
 * numeric fit), holding the other parameters at the current ones, and
 * re-simulates with the result.
 */
export function fitOverlay(data: OverlayData): { readonly data: OverlayData; readonly recovery: Recovery } {
  const ball = ballTrajectory(data);
  if (!ball) throw new Error('no ball track to fit');
  const recovery = recoverMuAndRestitution(data.world, sinceRelease(ball.points, data.releaseSec), { base: data.params });
  return { data: withParams(data, recovery.params), recovery };
}

/**
 * Builds the overlay for a clip from the files the smoke scripts write:
 * scene.json (Muse Spark grounding) and sam-raw.txt (SAM 3.1 output).
 * Rapier must be initialised first.
 */
export function loadOverlayData(inputs: OverlayInputs): OverlayData {
  let json: unknown;
  try {
    json = JSON.parse(inputs.sceneJson);
  } catch {
    throw new Error('scene.json is not JSON');
  }
  const file = sceneFileSchema.safeParse(json);
  if (!file.success) throw new Error(`scene.json does not match the scene schema: ${file.error.issues[0]?.message ?? ''}`);
  const { imageSize, scene } = file.data;

  const calibration = calibrate(
    scene,
    imageSize,
    inputs.markerDistanceCm ?? file.data.markerDistanceCm ?? DEFAULT_MARKER_DISTANCE_CM,
  );
  const world = toWorldScene(scene, calibration);
  const parsed = parseSamText(inputs.samText);
  const trajectories = tracksToTrajectories(parsed.records, trackedObjectsFor(scene), calibration, { fps: inputs.fps });
  const ball = ballTrajectory({ trajectories });
  if (!ball || ball.points.length === 0) throw new Error('sam-raw.txt has no ball track (object 1)');

  // Fit the release over most of the ramp run, stopping short of the end where the ball leaves it.
  const start = ballStart(world);
  const rampRunCm = Math.hypot(world.ramp.bottom.x - start.x, world.ramp.bottom.y - start.y);
  const releaseSec = detectReleaseTime(ball.points, RELEASE_FIT_SHARE * rampRunCm) ?? ball.points[0]?.t ?? 0;
  const lastSec = ball.points.at(-1)?.t ?? releaseSec;
  const durationSec = Math.min(MAX_SIM_SEC, Math.max(1, lastSec - releaseSec + SIM_TAIL_SEC));
  return {
    calibration,
    world,
    fps: inputs.fps,
    trajectories,
    masks: masksByFrame(parsed.records),
    droppedRecords: parsed.diagnostics.filter((d) => d.severity === 'error').length,
    releaseSec,
    params: inputs.params,
    sim: simulateScene(world, inputs.params, { durationSec }),
  };
}

/** The video frame showing at media time `t`: frame n is shown from n / fps. */
export function frameAtTime(t: number, fps: number): number {
  return Math.max(0, Math.floor(t * fps + 1e-6));
}

/** The measured path up to time `t`, in source pixels, split where the tracker lost the object. */
export function trailUntil(trajectory: ObjectTrajectory, t: number): Vec2[][] {
  const runs: Vec2[][] = [];
  let run: Vec2[] = [];
  let prevFrame = Number.NEGATIVE_INFINITY;
  for (const p of trajectory.points) {
    if (p.t > t) break;
    if (p.frame - prevFrame > TRAIL_GAP_FRAMES && run.length) {
      runs.push(run);
      run = [];
    }
    run.push(p.px);
    prevFrame = p.frame;
  }
  if (run.length) runs.push(run);
  return runs;
}

export interface Ghost {
  /** The simulated path so far, source pixels. */
  readonly path: Vec2[];
  readonly ball: Vec2;
  readonly angle: number;
  readonly radiusPx: number;
}

/** The simulated ball at clip time `t`: at rest on its start until the release, then following the run. */
export function ghostAt(data: Pick<OverlayData, 'sim' | 'calibration' | 'releaseSec' | 'world'>, t: number): Ghost {
  const { sim, calibration } = data;
  const simT = t - data.releaseSec;
  const index = Math.min(sim.samples.length - 1, Math.max(0, Math.floor(simT / sim.dt + 1e-6)));
  const path = sim.samples.slice(0, index + 1).map((s) => worldToPixel(calibration, s));
  const now = sim.samples[index] ?? sim.samples[0];
  return {
    path,
    ball: now ? worldToPixel(calibration, now) : worldToPixel(calibration, data.world.ball.center),
    angle: now?.angle ?? 0,
    radiusPx: data.world.ball.radius * calibration.pixelsPerCm,
  };
}
