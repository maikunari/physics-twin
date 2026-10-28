import { decodeMaskToRaster, type SegmentationMaskRecord } from '@meta-sam/parser';
import type { Vec2 } from '../scene/calibration';
import { frameAtTime, ghostAt, trailUntil, type OverlayData } from './overlayData';

const COLOURS = {
  ballMask: [249, 115, 22],
  blockMask: [59, 130, 246],
  trail: '#22d3ee',
  ghost: '#f8fafc',
  text: '#f8fafc',
} as const;
const MASK_ALPHA = 110;

/** Decoded masks, one small canvas per record, so a paused or replayed frame does not decode again. */
export type MaskCache = WeakMap<SegmentationMaskRecord, HTMLCanvasElement | null>;

function maskCanvas(record: SegmentationMaskRecord, kind: 'ball' | 'block', cache: MaskCache): HTMLCanvasElement | null {
  const cached = cache.get(record);
  if (cached !== undefined) return cached;
  let canvas: HTMLCanvasElement | null;
  try {
    const { width, height } = record.mask;
    const raster = decodeMaskToRaster(record.mask);
    canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      const image = ctx.createImageData(width, height);
      const [r, g, b] = kind === 'ball' ? COLOURS.ballMask : COLOURS.blockMask;
      raster.forEach((on, i) => {
        if (!on) return;
        image.data[i * 4] = r;
        image.data[i * 4 + 1] = g;
        image.data[i * 4 + 2] = b;
        image.data[i * 4 + 3] = MASK_ALPHA;
      });
      ctx.putImageData(image, 0, 0);
    }
  } catch {
    // The parser validated it, so this is unexpected; skip the mask rather than the frame.
    canvas = null;
  }
  cache.set(record, canvas);
  return canvas;
}

function polyline(ctx: CanvasRenderingContext2D, points: readonly Vec2[]) {
  const [first, ...rest] = points;
  if (!first) return;
  ctx.beginPath();
  ctx.moveTo(first.x, first.y);
  for (const p of rest) ctx.lineTo(p.x, p.y);
  ctx.stroke();
}

/**
 * Draws one frame of the overlay at media time `t`, in source pixels (the
 * canvas is the clip's size and scaled with the video): SAM masks for the
 * frame on screen, the measured ball trail so far, and the simulated ball
 * with its path.
 */
export function drawOverlay(ctx: CanvasRenderingContext2D, data: OverlayData, t: number, cache: MaskCache): void {
  const { width, height } = data.calibration.imageSize;
  const unit = height / 540;
  ctx.clearRect(0, 0, width, height);

  const frame = frameAtTime(t, data.fps);
  const kindOf = new Map(data.trajectories.map((tr) => [tr.object.id, tr.object.kind]));
  for (const record of data.masks.get(frame) ?? []) {
    const kind = kindOf.get(record.objectId);
    if (!kind) continue;
    const canvas = maskCanvas(record, kind, cache);
    const { left, top, right, bottom } = record.bounds;
    if (canvas) ctx.drawImage(canvas, left, top, right - left, bottom - top);
  }

  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.strokeStyle = COLOURS.trail;
  ctx.lineWidth = 1.5 * unit;
  for (const trajectory of data.trajectories) {
    if (trajectory.object.kind !== 'ball') continue;
    for (const run of trailUntil(trajectory, t)) polyline(ctx, run);
  }

  const ghost = ghostAt(data, t);
  ctx.strokeStyle = COLOURS.ghost;
  ctx.setLineDash([4 * unit, 3 * unit]);
  ctx.lineWidth = 1 * unit;
  polyline(ctx, ghost.path);
  ctx.setLineDash([]);
  ctx.lineWidth = 1.5 * unit;
  ctx.beginPath();
  ctx.arc(ghost.ball.x, ghost.ball.y, ghost.radiusPx, 0, Math.PI * 2);
  ctx.stroke();
  // A spoke so the simulated spin is visible; world angles turn anticlockwise, image y points down.
  ctx.beginPath();
  ctx.moveTo(ghost.ball.x, ghost.ball.y);
  ctx.lineTo(ghost.ball.x + ghost.radiusPx * Math.cos(-ghost.angle), ghost.ball.y + ghost.radiusPx * Math.sin(-ghost.angle));
  ctx.stroke();

  ctx.fillStyle = COLOURS.text;
  ctx.font = `${10 * unit}px system-ui, sans-serif`;
  ctx.fillText(`t ${t.toFixed(3)} s · frame ${frame}`, 8 * unit, 16 * unit);
}
