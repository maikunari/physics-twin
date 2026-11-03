import { decodeMaskToRaster, type SegmentationMaskRecord } from '@meta-sam/parser';
import type { Prediction } from '../predict/prediction';
import type { RevealOutcome } from '../predict/reveal';
import { worldToPixel, type Vec2 } from '../scene/calibration';
import { describeEdit } from '../whatif/applyEdit';
import type { CounterfactualPoint } from '../whatif/compare';
import type { WhatIfRun } from '../whatif/run';
import { frameAtTime, ghostAt, trailUntil, type OverlayData } from './overlayData';

const COLOURS = {
  ballMask: [249, 115, 22],
  blockMask: [59, 130, 246],
  trail: '#22d3ee',
  ghost: '#f8fafc',
  /** The simulated path past the fit window: what the fitted parameters predict, not what they were fitted on. */
  ghostAfterWindow: '#c4b5fd',
  text: '#f8fafc',
  /** The 12 sampled futures and the band their event falls in. */
  ensemble: 'rgba(251, 191, 36, 0.45)',
  band: '#fbbf24',
  predicted: '#22d3ee',
  inside: '#4ade80',
  outside: '#f87171',
  /** The what-if: the edited scene and the ball's new future. */
  whatIf: '#f59e0b',
  whatIfFaint: 'rgba(245, 158, 11, 0.35)',
  /** A real take filmed with the change made for real. */
  counterfactual: '#a3e635',
} as const;

/** What the what-if step adds to the overlay: the amber run, and the real counterfactual take if one is loaded. */
export interface WhatIfOverlay {
  /** Clip time of the run's t = 0: the release as the fit placed it. */
  readonly clockZeroSec: number;
  readonly run: WhatIfRun;
  readonly counterfactual: { readonly take: string; readonly points: readonly CounterfactualPoint[] } | null;
}

/** What the predict step adds to the overlay: the committed prediction, and once revealed, how it did. */
export interface PredictOverlay {
  /** Clip time of the prediction's t = 0: the detected release. */
  readonly clockZeroSec: number;
  readonly prediction: Prediction;
  readonly commitmentShort: string;
  /** False while the clip is held at the freeze. */
  readonly revealed: boolean;
  readonly outcome: RevealOutcome | null;
}
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

function marker(ctx: CanvasRenderingContext2D, p: Vec2, r: number, colour: string, width: number) {
  ctx.strokeStyle = colour;
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
  ctx.stroke();
}

/** Text on a dark backing, so it reads on any footage. */
function label(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, colour: string, unit: number) {
  const width = ctx.measureText(text).width;
  ctx.fillStyle = 'rgba(2, 6, 23, 0.75)';
  ctx.fillRect(x - 4 * unit, y - 11 * unit, width + 8 * unit, 15 * unit);
  ctx.fillStyle = colour;
  ctx.fillText(text, x, y);
}

/**
 * The predict step, drawn from the freeze on: the 12 sampled futures, the
 * nominal event with its band, the commitment, a dimmed frame while the
 * clip is held, and after the reveal the real event with its error.
 */
function drawPrediction(ctx: CanvasRenderingContext2D, data: OverlayData, t: number, predict: PredictOverlay, unit: number) {
  const { prediction, clockZeroSec } = predict;
  const cal = data.calibration;
  const freezeClip = clockZeroSec + prediction.freezeSec;
  if (t < freezeClip - 1 / data.fps) return;
  const px = (p: Vec2) => worldToPixel(cal, p);
  const { width, height } = cal.imageSize;

  if (!predict.revealed) {
    ctx.fillStyle = 'rgba(2, 6, 23, 0.35)';
    ctx.fillRect(0, 0, width, height);
  }

  ctx.lineWidth = 1 * unit;
  ctx.strokeStyle = COLOURS.ensemble;
  for (const member of prediction.members) polyline(ctx, member.path.map(px));

  const { band, nominal } = prediction;
  const event = px(nominal.event);
  const radius = data.world.ball.radius * cal.pixelsPerCm;
  // The band along the table at the event's height, with end ticks.
  const a = px({ x: band.x[0], y: nominal.event.y });
  const b = px({ x: band.x[1], y: nominal.event.y });
  ctx.strokeStyle = COLOURS.band;
  ctx.lineWidth = 2 * unit;
  polyline(ctx, [a, b]);
  for (const end of [a, b]) polyline(ctx, [{ x: end.x, y: end.y - 6 * unit }, { x: end.x, y: end.y + 6 * unit }]);
  marker(ctx, event, radius + 3 * unit, COLOURS.predicted, 2 * unit);

  ctx.font = `${10 * unit}px system-ui, sans-serif`;
  const cm = (v: number) => v.toFixed(1);
  label(
    ctx,
    `PREDICTED ${band.kind.toUpperCase()} · x ${cm(nominal.event.x)} cm (${cm(band.x[0])}–${cm(band.x[1])}) · t ${nominal.event.t.toFixed(3)} s · ${band.agreeing}/${band.total} runs`,
    8 * unit,
    46 * unit,
    COLOURS.predicted,
    unit,
  );
  label(ctx, `commitment ${predict.commitmentShort}`, 8 * unit, 62 * unit, COLOURS.text, unit);
  if (!predict.revealed) {
    label(ctx, `FROZEN at ${prediction.freezeSec.toFixed(3)} s after release: the footage past here has not been read`, 8 * unit, 78 * unit, COLOURS.band, unit);
    return;
  }

  const outcome = predict.outcome;
  const real = outcome?.event.real;
  if (!outcome || !real || t < clockZeroSec + real.t) return;
  const colour = outcome.event.insideBand ? COLOURS.inside : COLOURS.outside;
  marker(ctx, px(real), radius + 3 * unit, colour, 2 * unit);
  const e = outcome.event;
  label(
    ctx,
    `${e.insideBand ? '✓ INSIDE THE BAND' : '✗ OUTSIDE THE BAND'} · error ${e.errorCm?.toFixed(2)} cm / ${e.errorPx?.toFixed(1)} px${e.errorMs === null ? '' : ` / ${e.errorMs.toFixed(1)} ms`}`,
    8 * unit,
    78 * unit,
    colour,
    unit,
  );
}

/**
 * The what-if, in amber: the edited ramp, the blocks taken out (crossed),
 * the whole new path faintly and the ball on it at clip time `t`, and where
 * it lands. A real counterfactual take is drawn green, on its own release.
 */
function drawWhatIf(ctx: CanvasRenderingContext2D, data: OverlayData, t: number, whatIf: WhatIfOverlay, unit: number) {
  const cal = data.calibration;
  const px = (p: Vec2) => worldToPixel(cal, p);
  const { edited } = whatIf.run;
  const simT = t - whatIf.clockZeroSec;

  ctx.strokeStyle = COLOURS.whatIf;
  ctx.lineWidth = 3 * unit;
  polyline(ctx, [px(edited.world.ramp.top), px(edited.world.ramp.bottom)]);
  const kept = new Set(edited.world.blocks.map((b) => b.id));
  ctx.lineWidth = 2 * unit;
  for (const block of data.world.blocks) {
    if (kept.has(block.id)) continue;
    const a = px({ x: block.center.x - block.halfExtents.x, y: block.center.y + block.halfExtents.y });
    const b = px({ x: block.center.x + block.halfExtents.x, y: block.center.y - block.halfExtents.y });
    ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
    polyline(ctx, [a, b]);
    polyline(ctx, [{ x: a.x, y: b.y }, { x: b.x, y: a.y }]);
  }

  ctx.lineWidth = 1.5 * unit;
  ctx.strokeStyle = COLOURS.whatIfFaint;
  polyline(ctx, edited.path.map(px));
  const upTo = edited.path.filter((p) => p.t <= Math.max(0, simT));
  ctx.strokeStyle = COLOURS.whatIf;
  polyline(ctx, upTo.map(px));
  const now = upTo.at(-1) ?? edited.path[0];
  if (now) marker(ctx, px(now), data.world.ball.radius * cal.pixelsPerCm, COLOURS.whatIf, 2 * unit);
  if (edited.landing) marker(ctx, px(edited.landing), 4 * unit, COLOURS.whatIf, 2 * unit);

  if (whatIf.counterfactual) {
    ctx.strokeStyle = COLOURS.counterfactual;
    ctx.setLineDash([2 * unit, 2 * unit]);
    ctx.lineWidth = 1.5 * unit;
    polyline(
      ctx,
      whatIf.counterfactual.points.filter((p) => p.t <= simT).map((p) => p.px),
    );
    ctx.setLineDash([]);
  }

  ctx.font = `${10 * unit}px system-ui, sans-serif`;
  const landing = edited.landing ? `lands x ${edited.landing.x.toFixed(1)} cm at ${edited.landing.t.toFixed(3)} s` : 'no landing';
  label(ctx, `WHAT-IF: ${describeEdit(whatIf.run.edit, data.world)} · ${landing}`, 8 * unit, 94 * unit, COLOURS.whatIf, unit);
  if (whatIf.counterfactual) label(ctx, `REAL ${whatIf.counterfactual.take} (filmed with the change)`, 8 * unit, 110 * unit, COLOURS.counterfactual, unit);
}

/**
 * Draws one frame of the overlay at media time `t`, in source pixels (the
 * canvas is the clip's size and scaled with the video): SAM masks for the
 * frame on screen, the measured ball trail so far, the simulated ball with
 * its path and, once there is one, the prediction.
 */
export function drawOverlay(
  ctx: CanvasRenderingContext2D,
  data: OverlayData,
  t: number,
  cache: MaskCache,
  predict: PredictOverlay | null = null,
  whatIf: WhatIfOverlay | null = null,
): void {
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
  ctx.setLineDash([4 * unit, 3 * unit]);
  ctx.lineWidth = 1 * unit;
  ctx.strokeStyle = COLOURS.ghost;
  polyline(ctx, ghost.path.slice(0, ghost.fittedPoints));
  ctx.strokeStyle = COLOURS.ghostAfterWindow;
  polyline(ctx, ghost.path.slice(Math.max(0, ghost.fittedPoints - 1)));
  ctx.setLineDash([]);
  ctx.strokeStyle = ghost.path.length > ghost.fittedPoints ? COLOURS.ghostAfterWindow : COLOURS.ghost;
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
  if (ghost.path.length > ghost.fittedPoints) ctx.fillText('past the fit window: simulated, not fitted', 8 * unit, 30 * unit);
  if (predict) drawPrediction(ctx, data, t, predict, unit);
  if (whatIf) drawWhatIf(ctx, data, t, whatIf, unit);
}
