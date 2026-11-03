import { describe, expect, it } from 'vitest';
import { createActor } from 'xstate';
import { FIXTURE_IMAGE_SIZE, FIXTURE_SCENE } from '../scene/fixtures';
import { formatSamFrameLine, samPromptObjects } from '../tracks/samText';
import { CLIP_INTAKE_STATES, clipIntakeMachine, hasBallTrack, isUsableSceneJson, type ClipIntakeEvent, type ClipIntakeState } from './clipIntake';

const CLIP = { mimeType: 'video/quicktime', durationSec: 3, sizeBytes: 20e6 };
const SCENE_JSON = JSON.stringify({ imageSize: FIXTURE_IMAGE_SIZE, markerDistanceCm: 50, scene: FIXTURE_SCENE });
const NO_SCALE_JSON = JSON.stringify({
  imageSize: FIXTURE_IMAGE_SIZE,
  scene: { ...FIXTURE_SCENE, scaleMarkers: [FIXTURE_SCENE.scaleMarkers[0], FIXTURE_SCENE.scaleMarkers[0]] },
});
const ballFrames = (n: number) =>
  Array.from({ length: n }, (_, f) =>
    formatSamFrameLine(f, [{ objectId: '1', box: { left: 190 + f, top: 380, right: 230 + f, bottom: 420 }, confidence: 0.9 }], FIXTURE_IMAGE_SIZE),
  ).join('');
const TRACKED = ballFrames(40);

function start(...events: ClipIntakeEvent[]) {
  const actor = createActor(clipIntakeMachine).start();
  for (const e of events) actor.send(e);
  return actor;
}
const stateOf = (actor: ReturnType<typeof start>) => actor.getSnapshot().value as ClipIntakeState;

const REACH: Record<ClipIntakeState, ClipIntakeEvent[]> = {
  idle: [],
  readingScene: [{ type: 'PICK', clip: CLIP }],
  tracking: [{ type: 'PICK', clip: CLIP }, { type: 'SCENE_READY', sceneJson: SCENE_JSON }],
  done: [{ type: 'PICK', clip: CLIP }, { type: 'SCENE_READY', sceneJson: SCENE_JSON }, { type: 'TRACKS_READY', samText: TRACKED }],
  failed: [{ type: 'PICK', clip: CLIP }, { type: 'SCENE_FAILED', error: '/api/scene answered 429' }],
};

describe('clipIntake transitions', () => {
  it.each([
    ['idle', { type: 'PICK', clip: CLIP }, 'readingScene'],
    ['idle', { type: 'PICK', clip: { ...CLIP, durationSec: 6 } }, 'failed'],
    ['idle', { type: 'PICK', clip: { ...CLIP, sizeBytes: 60e6 } }, 'failed'],
    ['idle', { type: 'PICK', clip: { ...CLIP, mimeType: 'image/jpeg' } }, 'failed'],
    ['readingScene', { type: 'SCENE_READY', sceneJson: SCENE_JSON }, 'tracking'],
    ['readingScene', { type: 'SCENE_READY', sceneJson: NO_SCALE_JSON }, 'failed'],
    ['readingScene', { type: 'SCENE_READY', sceneJson: '{' }, 'failed'],
    ['readingScene', { type: 'SCENE_FAILED', error: 'x' }, 'failed'],
    ['tracking', { type: 'TRACKS_READY', samText: TRACKED }, 'done'],
    ['tracking', { type: 'TRACKS_READY', samText: ballFrames(10) }, 'failed'],
    ['tracking', { type: 'TRACK_FAILED', error: 'x' }, 'failed'],
    ['done', { type: 'RESET' }, 'idle'],
    ['failed', { type: 'RESET' }, 'idle'],
  ] as [ClipIntakeState, ClipIntakeEvent, ClipIntakeState][])('%s --%o--> %s', (from, event, to) => {
    const actor = start(...REACH[from]);
    expect(stateOf(actor)).toBe(from);
    actor.send(event);
    expect(stateOf(actor)).toBe(to);
  });

  it('covers every state', () => {
    expect(Object.keys(REACH).sort()).toEqual([...CLIP_INTAKE_STATES].sort());
  });

  it.each([
    ['idle', { type: 'SCENE_READY', sceneJson: SCENE_JSON }],
    ['idle', { type: 'TRACKS_READY', samText: TRACKED }],
    ['readingScene', { type: 'TRACKS_READY', samText: TRACKED }],
    ['readingScene', { type: 'PICK', clip: CLIP }],
    ['tracking', { type: 'SCENE_READY', sceneJson: SCENE_JSON }],
    ['done', { type: 'PICK', clip: CLIP }],
  ] as [ClipIntakeState, ClipIntakeEvent][])('ignores in %s: %o', (from, event) => {
    const actor = start(...REACH[from]);
    actor.send(event);
    expect(stateOf(actor)).toBe(from);
  });

  it('keeps what the API made, and says why it failed', () => {
    expect(start(...REACH.done).getSnapshot().context).toMatchObject({ clip: CLIP, sceneJson: SCENE_JSON, samText: TRACKED, error: null });
    expect(start(...REACH.failed).getSnapshot().context.error).toBe('/api/scene answered 429');
    const short = start(...REACH.tracking, { type: 'TRACKS_READY', samText: ballFrames(5) });
    expect(short.getSnapshot().context.error).toMatch(/fewer than 30 frames/);
    expect(start(...REACH.done, { type: 'RESET' }).getSnapshot().context).toEqual({ clip: null, sceneJson: null, samText: null, error: null });
  });
});

describe('clipIntake guards', () => {
  it('a scene file must parse and have a scale', () => {
    expect(isUsableSceneJson(SCENE_JSON)).toBe(true);
    expect(isUsableSceneJson(NO_SCALE_JSON)).toBe(false);
    expect(isUsableSceneJson('nope')).toBe(false);
  });

  it('counts the ball’s frames, not other objects’ or repeated ones', () => {
    expect(hasBallTrack(ballFrames(30))).toBe(true);
    expect(hasBallTrack(ballFrames(29))).toBe(false);
    const blockOnly = Array.from({ length: 40 }, (_, f) =>
      formatSamFrameLine(f, [{ objectId: '2', box: { left: 10, top: 10, right: 50, bottom: 50 } }], FIXTURE_IMAGE_SIZE),
    ).join('');
    expect(hasBallTrack(blockOnly)).toBe(false);
  });

  it('prompts SAM with the ball as object 1 and the blocks after it', () => {
    const objects = samPromptObjects(FIXTURE_SCENE, FIXTURE_IMAGE_SIZE);
    expect(objects.map((o) => o.id)).toEqual(['1', '2']);
    const ball = objects[0]!.box;
    expect((ball.left + ball.right) / 2).toBeCloseTo((105 * 1920) / 1000, -1);
    expect(objects[1]!.box).toEqual({ left: 1497, top: 604, right: 1594, bottom: 692 });
  });
});
