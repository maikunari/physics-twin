import { assign, setup } from 'xstate';
import { groundedSceneSchema, hasUsableScale, type GroundedScene } from '../scene/schema';
import { whatIfEditSchema, type WhatIfEdit } from '../scene/whatIfEdit';

/** Clip limits from spec §6.1. */
export const MAX_CLIP_SECONDS = 5;
export const MAX_CLIP_BYTES = 50 * 1024 * 1024;
/** A ball must be tracked over at least this many frames for the fit to have data. */
export const MIN_BALL_TRACK_FRAMES = 30;

export interface ClipInfo {
  readonly mimeType: string;
  readonly durationSec: number;
  readonly sizeBytes: number;
}

export interface TrackSummary {
  readonly objectId: string;
  readonly kind: 'ball' | 'block';
  readonly frameCount: number;
}

export interface FitSummary {
  readonly rms: number;
  readonly iterations: number;
}

export interface AppFlowInput {
  /** FIT_DONE is accepted once RMS is at or below this (same units as `FitSummary.rms`). */
  readonly rmsThreshold: number;
  /** …or once the fit has run this many iterations. */
  readonly maxFitIterations: number;
}

export interface AppFlowContext extends AppFlowInput {
  readonly clip: ClipInfo | null;
  readonly tracks: readonly TrackSummary[];
  readonly scene: GroundedScene | null;
  readonly fit: FitSummary | null;
  /** Short hash of the predicted landing, logged before reality plays (spec §5). */
  readonly commitmentHash: string | null;
  readonly edits: readonly WhatIfEdit[];
  readonly error: string | null;
}

export type AppFlowEvent =
  | { type: 'CLIP_SELECTED'; clip: ClipInfo }
  | { type: 'TRACKS_READY'; tracks: readonly TrackSummary[] }
  | { type: 'TRACK_FAILED'; error: string }
  | { type: 'SCENE_READY'; scene: unknown }
  | { type: 'SCENE_FAILED'; error: string }
  | { type: 'FIT_DONE'; fit: FitSummary }
  | { type: 'PREDICT' }
  | { type: 'PREDICTION_READY'; commitmentHash: string }
  | { type: 'REVEAL_DONE' }
  | { type: 'OPEN_WHATIF' }
  | { type: 'APPLY_EDIT'; edit: unknown }
  | { type: 'RESET' }
  | { type: 'RETRY' };

/** A commitment is a lowercase hex digest of at least 8 characters. */
const COMMITMENT_HASH = /^[0-9a-f]{8,64}$/;

export function isClipAcceptable(clip: ClipInfo): boolean {
  return (
    clip.mimeType.startsWith('video/') &&
    clip.durationSec > 0 &&
    clip.durationSec <= MAX_CLIP_SECONDS &&
    clip.sizeBytes > 0 &&
    clip.sizeBytes <= MAX_CLIP_BYTES
  );
}

export function hasTrackedBall(tracks: readonly TrackSummary[]): boolean {
  return tracks.some((t) => t.kind === 'ball' && t.frameCount >= MIN_BALL_TRACK_FRAMES);
}

export function isSceneUsable(scene: unknown): boolean {
  const parsed = groundedSceneSchema.safeParse(scene);
  return parsed.success && hasUsableScale(parsed.data);
}

export const APP_FLOW_STATES = [
  'pickClip',
  'tracking',
  'sceneReading',
  'fitting',
  'frozen',
  'predicting',
  'revealing',
  'result',
  'whatIf',
  'error',
] as const;
export type AppFlowState = (typeof APP_FLOW_STATES)[number];

const clearedPrediction = { commitmentHash: null, edits: [] } as const;

/** AppFlow, spec §6.1: one clip from selection to prediction, reveal and what-ifs. */
export const appFlowMachine = setup({
  types: {
    context: {} as AppFlowContext,
    events: {} as AppFlowEvent,
    input: {} as AppFlowInput,
  },
  guards: {
    clipAcceptable: ({ event }) => event.type === 'CLIP_SELECTED' && isClipAcceptable(event.clip),
    ballTracked: ({ event }) => event.type === 'TRACKS_READY' && hasTrackedBall(event.tracks),
    sceneUsable: ({ event }) => event.type === 'SCENE_READY' && isSceneUsable(event.scene),
    fitGoodEnough: ({ context, event }) =>
      event.type === 'FIT_DONE' &&
      Number.isFinite(event.fit.rms) &&
      (event.fit.rms <= context.rmsThreshold || event.fit.iterations >= context.maxFitIterations),
    hashCommitted: ({ event }) =>
      event.type === 'PREDICTION_READY' && COMMITMENT_HASH.test(event.commitmentHash),
    editValid: ({ context, event }) => {
      if (event.type !== 'APPLY_EDIT') return false;
      const parsed = whatIfEditSchema.safeParse(event.edit);
      if (!parsed.success) return false;
      const blockIds = new Set(context.scene?.blocks.map((b) => b.id));
      return parsed.data.removeBlockIds.every((id) => blockIds.has(id));
    },
  },
}).createMachine({
  id: 'appFlow',
  initial: 'pickClip',
  context: ({ input }) => ({
    ...input,
    clip: null,
    tracks: [],
    scene: null,
    fit: null,
    commitmentHash: null,
    edits: [],
    error: null,
  }),
  states: {
    pickClip: {
      on: {
        CLIP_SELECTED: {
          guard: 'clipAcceptable',
          target: 'tracking',
          actions: assign({ clip: ({ event }) => event.clip }),
        },
      },
    },
    tracking: {
      on: {
        TRACKS_READY: {
          guard: 'ballTracked',
          target: 'sceneReading',
          actions: assign({ tracks: ({ event }) => event.tracks }),
        },
        TRACK_FAILED: { target: 'error', actions: assign({ error: ({ event }) => event.error }) },
      },
    },
    sceneReading: {
      on: {
        SCENE_READY: {
          guard: 'sceneUsable',
          target: 'fitting',
          actions: assign({ scene: ({ event }) => groundedSceneSchema.parse(event.scene) }),
        },
        SCENE_FAILED: { target: 'error', actions: assign({ error: ({ event }) => event.error }) },
      },
    },
    fitting: {
      on: {
        FIT_DONE: {
          guard: 'fitGoodEnough',
          target: 'frozen',
          actions: assign({ fit: ({ event }) => event.fit }),
        },
      },
    },
    frozen: {
      on: { PREDICT: 'predicting' },
    },
    predicting: {
      on: {
        PREDICTION_READY: {
          guard: 'hashCommitted',
          target: 'revealing',
          actions: assign({ commitmentHash: ({ event }) => event.commitmentHash }),
        },
      },
    },
    revealing: {
      on: { REVEAL_DONE: 'result' },
    },
    result: {
      on: {
        OPEN_WHATIF: 'whatIf',
        RESET: { target: 'frozen', actions: assign(clearedPrediction) },
      },
    },
    whatIf: {
      on: {
        APPLY_EDIT: {
          guard: 'editValid',
          target: 'whatIf',
          actions: assign({
            edits: ({ context, event }) => [...context.edits, whatIfEditSchema.parse(event.edit)],
          }),
        },
        RESET: { target: 'frozen', actions: assign(clearedPrediction) },
      },
    },
    error: {
      on: {
        RETRY: {
          target: 'pickClip',
          actions: assign({ clip: null, tracks: [], scene: null, fit: null, ...clearedPrediction, error: null }),
        },
      },
    },
  },
});

