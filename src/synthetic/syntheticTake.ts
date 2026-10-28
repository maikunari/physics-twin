import {
  ballRadiusPx,
  calibrate,
  gridBoxToPixelBox,
  toWorldScene,
  worldToPixel,
  type Calibration,
  type ImageSize,
  type PixelBox,
  type WorldScene,
} from '../scene/calibration';
import type { GroundedScene } from '../scene/schema';
import type { SimParams } from '../sim/params';
import { createPrng } from '../sim/prng';
import { simulateScene, type Trajectory, type WorldOptions } from '../sim/sceneWorld';
import { formatSamFrameLine, type SamWireRecord, type TrackedObject } from '../tracks/samText';

export interface SyntheticTakeOptions extends Pick<WorldOptions, 'ballKind'> {
  /** How long the ball is simulated after release; the clip is releaseDelaySec longer. */
  readonly durationSec: number;
  readonly fps?: number;
  readonly markerDistanceCm?: number;
  /** Seeds the measurement noise, so a take replays exactly. */
  readonly seed?: number;
  /** Standard deviation of the ball centre's pixel jitter, px. */
  readonly pixelNoise?: number;
  /** Share of frames where SAM loses the ball (no box). */
  readonly dropRate?: number;
  /** Share of frames where SAM reports a wrong box at low confidence. */
  readonly lowConfidenceRate?: number;
  /** The ball sits at the release mark this long before it is let go (the filming guide waits 1 s). */
  readonly releaseDelaySec?: number;
}

/** A take generated from the simulation, in the same shapes a real clip produces. */
export interface SyntheticTake {
  readonly calibration: Calibration;
  readonly world: WorldScene;
  /** The ground truth the measurement was made from, in cm; its t = 0 is the release. */
  readonly truth: Trajectory;
  /** The clip frame where the ball is let go: truth sample i is clip frame releaseFrame + i. */
  readonly releaseFrame: number;
  /** Objects as SAM would have been prompted: the ball is 1, blocks follow in scene order (as in smoke-sam.ts). */
  readonly objects: readonly TrackedObject[];
  /** SAM 3.1 video output for the take, in the wire grammar `sam-raw.txt` holds. */
  readonly samText: string;
  /** The ball's true centre in source pixels per frame (before noise), for rendering a clip. */
  readonly ballPx: readonly { readonly x: number; readonly y: number }[];
  readonly ballRadiusPx: number;
}

/** Standard normal deviate from a uniform PRNG (Box–Muller). */
function gaussian(rand: () => number): number {
  const u = 1 - rand();
  const v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function boxAround(cx: number, cy: number, r: number, size: ImageSize): PixelBox {
  const left = Math.max(0, Math.round(cx - r));
  const top = Math.max(0, Math.round(cy - r));
  return {
    left,
    top,
    right: Math.min(size.width, Math.max(left + 1, Math.round(cx + r))),
    bottom: Math.min(size.height, Math.max(top + 1, Math.round(cy + r))),
  };
}

/**
 * Simulates a scene with known parameters and "films" it: the ball's path is
 * projected back to source pixels through the calibration and written out as
 * SAM 3.1 output, with integer boxes, pixel jitter, lost frames and
 * low-confidence wrong boxes. Feeding `samText` through the normal tracks
 * pipeline and recovering the parameters is the synthetic ground-truth test.
 */
export function makeSyntheticTake(
  scene: GroundedScene,
  imageSize: ImageSize,
  params: SimParams,
  options: SyntheticTakeOptions,
): SyntheticTake {
  const fps = options.fps ?? 240;
  const calibration = calibrate(scene, imageSize, options.markerDistanceCm);
  const world = toWorldScene(scene, calibration);
  const truth = simulateScene(world, params, {
    durationSec: options.durationSec,
    dt: 1 / fps,
    ...(options.ballKind ? { ballKind: options.ballKind } : {}),
  });

  const rand = createPrng(options.seed ?? 1);
  const noise = options.pixelNoise ?? 0;
  const dropRate = options.dropRate ?? 0;
  const lowConfidenceRate = options.lowConfidenceRate ?? 0;
  const r = ballRadiusPx(scene, imageSize);

  const objects: TrackedObject[] = [
    { id: '1', kind: 'ball', label: 'ball' },
    ...scene.blocks.map((b, i) => ({ id: String(i + 2), kind: 'block' as const, label: b.label })),
  ];
  const blockBoxes = scene.blocks.map((b) => gridBoxToPixelBox(b.box, imageSize));

  const releaseFrame = Math.round((options.releaseDelaySec ?? 0) * fps);
  const restPx = worldToPixel(calibration, world.ball.center);
  const ballPx = [
    ...Array.from({ length: releaseFrame }, () => restPx),
    ...truth.samples.map((s) => worldToPixel(calibration, s)),
  ];
  const lines = ballPx.map((p, frame) => {
    const records: SamWireRecord[] = [];
    const roll = rand();
    if (roll >= dropRate) {
      if (roll < dropRate + lowConfidenceRate) {
        // The tracker hopped somewhere else for a frame and says it is unsure.
        const off = 6 * r;
        records.push({ objectId: '1', box: boxAround(p.x + off, p.y - off, r, imageSize), confidence: 0.1 + 0.2 * rand() });
      } else {
        const cx = p.x + noise * gaussian(rand);
        const cy = p.y + noise * gaussian(rand);
        records.push({ objectId: '1', box: boxAround(cx, cy, r, imageSize), confidence: 0.85 + 0.14 * rand() });
      }
    }
    blockBoxes.forEach((box, i) => records.push({ objectId: String(i + 2), box, confidence: 0.95 }));
    return records.length ? formatSamFrameLine(frame, records, imageSize) : '';
  });

  return {
    calibration,
    world,
    truth,
    releaseFrame,
    objects,
    samText: lines.join(''),
    ballPx,
    ballRadiusPx: r,
  };
}
