import { frameIndexOf, recordsOfKind } from '@meta-sam/parser';
import { assign, setup } from 'xstate';
import { sceneFileSchema } from '../overlay/overlayData';
import { hasUsableScale } from '../scene/schema';
import { parseSamText } from '../tracks/samText';
import { isClipAcceptable, MIN_BALL_TRACK_FRAMES, type ClipInfo } from './appFlow';

export interface ClipIntakeContext {
  readonly clip: ClipInfo | null;
  /** scene.json text, as `/api/scene` answered it. */
  readonly sceneJson: string | null;
  /** sam-raw.txt text, as `/api/track` answered it. */
  readonly samText: string | null;
  readonly error: string | null;
}

export type ClipIntakeEvent =
  | { type: 'PICK'; clip: ClipInfo }
  | { type: 'SCENE_READY'; sceneJson: string }
  | { type: 'SCENE_FAILED'; error: string }
  | { type: 'TRACKS_READY'; samText: string }
  | { type: 'TRACK_FAILED'; error: string }
  | { type: 'RESET' };

export const CLIP_INTAKE_STATES = ['idle', 'readingScene', 'tracking', 'done', 'failed'] as const;
export type ClipIntakeState = (typeof CLIP_INTAKE_STATES)[number];

/** A scene file the page can load and calibrate. */
export function isUsableSceneJson(text: string): boolean {
  try {
    const file = sceneFileSchema.safeParse(JSON.parse(text));
    return file.success && hasUsableScale(file.data.scene);
  } catch {
    return false;
  }
}

/** SAM output with the ball (object 1) boxed on enough frames to fit (AppFlow's TRACKS_READY guard). */
export function hasBallTrack(samText: string): boolean {
  const boxes = recordsOfKind(parseSamText(samText).records, 'box').filter((r) => r.objectId === '1');
  return new Set(boxes.map((r) => frameIndexOf(r))).size >= MIN_BALL_TRACK_FRAMES;
}

const cleared = { clip: null, sceneJson: null, samText: null, error: null } as const;

/**
 * A clip with no tracks yet, through the thin server (AppFlow's pickClip →
 * sceneReading → tracking, in the order the calls need: SAM is prompted with
 * the boxes Muse Spark grounds on frame 0):
 *
 * - idle: no clip, or the last one loaded.
 * - readingScene: frame 0 is at `/api/scene` (Muse Spark grounding).
 * - tracking: the clip and the boxes are at `/api/track` (SAM 3.1).
 * - done: scene.json and sam-raw.txt are in hand; the page loads them like files.
 * - failed: a guard or a call refused the clip, with the reason.
 */
export const clipIntakeMachine = setup({
  types: { context: {} as ClipIntakeContext, events: {} as ClipIntakeEvent },
  guards: {
    clipAcceptable: ({ event }) => event.type === 'PICK' && isClipAcceptable(event.clip),
    sceneUsable: ({ event }) => event.type === 'SCENE_READY' && isUsableSceneJson(event.sceneJson),
    ballTracked: ({ event }) => event.type === 'TRACKS_READY' && hasBallTrack(event.samText),
  },
}).createMachine({
  id: 'clipIntake',
  initial: 'idle',
  context: { ...cleared },
  states: {
    idle: {
      on: {
        PICK: [
          { guard: 'clipAcceptable', target: 'readingScene', actions: assign({ ...cleared, clip: ({ event }) => event.clip }) },
          { target: 'failed', actions: assign({ ...cleared, error: 'pick a video of at most 5 s and 50 MB' }) },
        ],
      },
    },
    readingScene: {
      on: {
        SCENE_READY: [
          { guard: 'sceneUsable', target: 'tracking', actions: assign({ sceneJson: ({ event }) => event.sceneJson }) },
          { target: 'failed', actions: assign({ error: 'the scene has no usable scale (both tape marks must be in frame)' }) },
        ],
        SCENE_FAILED: { target: 'failed', actions: assign({ error: ({ event }) => event.error }) },
      },
    },
    tracking: {
      on: {
        TRACKS_READY: [
          { guard: 'ballTracked', target: 'done', actions: assign({ samText: ({ event }) => event.samText }) },
          { target: 'failed', actions: assign({ error: `SAM tracked the ball on fewer than ${MIN_BALL_TRACK_FRAMES} frames` }) },
        ],
        TRACK_FAILED: { target: 'failed', actions: assign({ error: ({ event }) => event.error }) },
      },
    },
    done: {
      on: { RESET: { target: 'idle', actions: assign(cleared) } },
    },
    failed: {
      on: { RESET: { target: 'idle', actions: assign(cleared) } },
    },
  },
});
