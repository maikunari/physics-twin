import type { WorldScene } from '../scene/calibration';
import type { Commitment } from './commitment';
import { distanceCm, findEvent, positionAt, type PathEvent, type PathPoint } from './events';
import type { Prediction } from './prediction';

/** A measured point further than this from its neighbour in time means the tracker lost the ball there, frames. */
const MAX_GAP_FRAMES = 3;

export interface EventScore {
  readonly predicted: PathEvent;
  /** The same kind of event on the measured track after the freeze, or null if it did not happen before the horizon. */
  readonly real: PathEvent | null;
  /** Distance between predicted and real event, cm and source pixels. */
  readonly errorCm: number | null;
  readonly errorPx: number | null;
  /** Real minus predicted time, ms: positive means reality was later. Null for a horizon event, which is at a fixed time. */
  readonly errorMs: number | null;
  /** Real event inside the ensemble band, along the table and in time (padded by a pixel and a frame); no time check for a horizon event. */
  readonly insideBandX: boolean | null;
  readonly insideBandT: boolean | null;
  /** Both; false when the event did not happen at all. */
  readonly insideBand: boolean;
}

/** How the prediction did against the footage after the freeze (spec §5: cm and px, ms, trajectory RMS in mm). */
export interface RevealOutcome {
  /** The commitment this outcome scores; the predict flow refuses an outcome for any other. */
  readonly commitmentHash: string;
  readonly event: EventScore;
  /** Where the ball was at the horizon, predicted against measured. */
  readonly end: {
    readonly predicted: PathPoint;
    readonly real: PathPoint | null;
    readonly errorCm: number | null;
    readonly errorPx: number | null;
  };
  /** Nominal run against every measured point from the freeze to the horizon. */
  readonly trajectory: { readonly points: number; readonly rmsMm: number | null; readonly rmsPx: number | null };
  readonly pixelsPerCm: number;
}

export interface RevealInputs {
  readonly prediction: Prediction;
  readonly commitment: Commitment;
  /** Every measured ball point of the take, t from the detected release (the prediction's clock). */
  readonly measured: readonly PathPoint[];
  readonly world: WorldScene;
  readonly pixelsPerCm: number;
  readonly fps: number;
}

const within = (v: number, [lo, hi]: readonly [number, number], pad: number) => v >= lo - pad && v <= hi + pad;

/**
 * Scores a committed prediction against the measured track after the freeze.
 * The real event is found with the same detector as the predicted one, for
 * the kind the prediction committed to. Distances in pixels are the
 * centimetre distances times the calibration's scale (the calibration is a
 * rotation and a scale, so this is exact).
 */
export function scoreReveal(inputs: RevealInputs): RevealOutcome {
  const { prediction, measured, world, pixelsPerCm, fps } = inputs;
  const { freezeSec, horizonEndSec, nominal, band } = prediction;
  const frame = 1 / fps;
  const maxGap = MAX_GAP_FRAMES * frame;

  const predicted = nominal.event;
  const real = findEvent(measured, world, predicted.kind, freezeSec, horizonEndSec, maxGap);
  const eventCm = real ? distanceCm(real, predicted) : null;
  // A horizon event is at a fixed time, so it has no time error.
  const timed = predicted.kind !== 'horizon';
  const insideBandX = real ? within(real.x, band.x, 1 / pixelsPerCm) : null;
  const insideBandT = real && timed ? within(real.t, band.t, frame) : null;

  const endReal = positionAt(measured, horizonEndSec, maxGap);
  const endCm = endReal ? distanceCm(endReal, nominal.end) : null;

  // The measured clock is shifted from the simulation's by the release correction, so the path is interpolated.
  const after = measured.filter((p) => p.t > freezeSec && p.t <= horizonEndSec);
  let sum = 0;
  let n = 0;
  for (const p of after) {
    const s = positionAt(nominal.path, p.t);
    if (!s) continue;
    sum += (s.x - p.x) ** 2 + (s.y - p.y) ** 2;
    n++;
  }
  const rmsCm = n > 0 ? Math.sqrt(sum / n) : null;

  return {
    commitmentHash: inputs.commitment.hash,
    event: {
      predicted,
      real,
      errorCm: eventCm,
      errorPx: eventCm === null ? null : eventCm * pixelsPerCm,
      errorMs: real && timed ? (real.t - predicted.t) * 1000 : null,
      insideBandX,
      insideBandT,
      insideBand: insideBandX === true && (!timed || insideBandT === true),
    },
    end: {
      predicted: nominal.end,
      real: endReal,
      errorCm: endCm,
      errorPx: endCm === null ? null : endCm * pixelsPerCm,
    },
    trajectory: {
      points: n,
      rmsMm: rmsCm === null ? null : rmsCm * 10,
      rmsPx: rmsCm === null ? null : rmsCm * pixelsPerCm,
    },
    pixelsPerCm,
  };
}
