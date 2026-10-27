import { describe, expect, it } from 'vitest';
import { createActor } from 'xstate';
import {
  APP_FLOW_STATES,
  MAX_CLIP_BYTES,
  appFlowMachine,
  type AppFlowContext,
  type AppFlowEvent,
  type AppFlowState,
} from './appFlow';
import { FIXTURE_SCENE } from '../scene/fixtures';
import { createPrng } from '../sim/prng';

const input = { rmsThreshold: 0.005, maxFitIterations: 40 };

const baseContext: AppFlowContext = {
  ...input,
  clip: null,
  tracks: [],
  scene: null,
  fit: null,
  commitmentHash: null,
  edits: [],
  error: null,
};

/** Starts an actor already resting in `state`, so each table row is tested on its own. */
function actorIn(state: AppFlowState, context: Partial<AppFlowContext> = {}) {
  const snapshot = appFlowMachine.resolveState({ value: state, context: { ...baseContext, ...context } });
  return createActor(appFlowMachine, { input, snapshot }).start();
}

const goodClip = { mimeType: 'video/quicktime', durationSec: 1.2, sizeBytes: 20_000_000 };
const ballTrack = { objectId: '1', kind: 'ball', frameCount: 240 } as const;
const HASH = '9f86d081884c7d65';

const valid: Record<AppFlowEvent['type'], AppFlowEvent> = {
  CLIP_SELECTED: { type: 'CLIP_SELECTED', clip: goodClip },
  TRACKS_READY: { type: 'TRACKS_READY', tracks: [ballTrack] },
  TRACK_FAILED: { type: 'TRACK_FAILED', error: 'SAM returned no ball' },
  SCENE_READY: { type: 'SCENE_READY', scene: FIXTURE_SCENE },
  SCENE_FAILED: { type: 'SCENE_FAILED', error: 'grounding timed out' },
  FIT_DONE: { type: 'FIT_DONE', fit: { rms: 0.003, iterations: 12 } },
  PREDICT: { type: 'PREDICT' },
  PREDICTION_READY: { type: 'PREDICTION_READY', commitmentHash: HASH },
  REVEAL_DONE: { type: 'REVEAL_DONE' },
  OPEN_WHATIF: { type: 'OPEN_WHATIF' },
  APPLY_EDIT: { type: 'APPLY_EDIT', edit: { rampAngleDeg: 32, removeBlockIds: ['blue'] } },
  RESET: { type: 'RESET' },
  RETRY: { type: 'RETRY' },
};

/** Context a state can only be in after the steps before it ran. */
const reachedContext: Partial<Record<AppFlowState, Partial<AppFlowContext>>> = {
  whatIf: { scene: FIXTURE_SCENE, commitmentHash: HASH },
  result: { scene: FIXTURE_SCENE, commitmentHash: HASH },
  revealing: { scene: FIXTURE_SCENE, commitmentHash: HASH },
};

// Spec §6.1, one entry per table row (the "whatIf / result → RESET" row is two entries).
const table: [AppFlowState, AppFlowEvent['type'], AppFlowState][] = [
  ['pickClip', 'CLIP_SELECTED', 'tracking'],
  ['tracking', 'TRACKS_READY', 'sceneReading'],
  ['tracking', 'TRACK_FAILED', 'error'],
  ['sceneReading', 'SCENE_READY', 'fitting'],
  ['sceneReading', 'SCENE_FAILED', 'error'],
  ['fitting', 'FIT_DONE', 'frozen'],
  ['frozen', 'PREDICT', 'predicting'],
  ['predicting', 'PREDICTION_READY', 'revealing'],
  ['revealing', 'REVEAL_DONE', 'result'],
  ['result', 'OPEN_WHATIF', 'whatIf'],
  ['whatIf', 'APPLY_EDIT', 'whatIf'],
  ['whatIf', 'RESET', 'frozen'],
  ['result', 'RESET', 'frozen'],
  ['error', 'RETRY', 'pickClip'],
];

describe('AppFlow transition table', () => {
  it.each(table)('%s --%s--> %s', (from, eventType, to) => {
    const actor = actorIn(from, reachedContext[from]);
    actor.send(valid[eventType]);
    expect(actor.getSnapshot().value).toBe(to);
  });

  it('records what each transition carries', () => {
    const actor = createActor(appFlowMachine, { input }).start();
    actor.send(valid.CLIP_SELECTED);
    actor.send(valid.TRACKS_READY);
    actor.send(valid.SCENE_READY);
    actor.send(valid.FIT_DONE);
    actor.send(valid.PREDICT);
    actor.send(valid.PREDICTION_READY);
    actor.send(valid.REVEAL_DONE);
    actor.send(valid.OPEN_WHATIF);
    actor.send(valid.APPLY_EDIT);
    const { value, context } = actor.getSnapshot();
    expect(value).toBe('whatIf');
    expect(context.clip).toEqual(goodClip);
    expect(context.tracks).toEqual([ballTrack]);
    expect(context.scene).toEqual(FIXTURE_SCENE);
    expect(context.fit).toEqual({ rms: 0.003, iterations: 12 });
    expect(context.commitmentHash).toBe(HASH);
    expect(context.edits).toHaveLength(1);
  });

  it('RESET clears the old commitment and edits so the next prediction commits afresh', () => {
    const actor = actorIn('whatIf', { ...reachedContext.whatIf, edits: [{ rampAngleDeg: 30, removeBlockIds: [] }] });
    actor.send(valid.RESET);
    expect(actor.getSnapshot().context.commitmentHash).toBeNull();
    expect(actor.getSnapshot().context.edits).toEqual([]);
    expect(actor.getSnapshot().context.scene).toEqual(FIXTURE_SCENE);
  });

  it('RETRY clears the failed run', () => {
    const actor = actorIn('error', { clip: goodClip, error: 'boom' });
    actor.send(valid.RETRY);
    expect(actor.getSnapshot().context).toEqual(baseContext);
  });
});

describe('AppFlow guards', () => {
  it.each([
    ['not a video', { ...goodClip, mimeType: 'image/png' }],
    ['longer than 5 s', { ...goodClip, durationSec: 5.01 }],
    ['larger than 50 MB', { ...goodClip, sizeBytes: MAX_CLIP_BYTES + 1 }],
    ['empty', { ...goodClip, sizeBytes: 0 }],
  ])('CLIP_SELECTED rejects a clip that is %s', (_why, clip) => {
    const actor = actorIn('pickClip');
    actor.send({ type: 'CLIP_SELECTED', clip });
    expect(actor.getSnapshot().value).toBe('pickClip');
  });

  it('CLIP_SELECTED accepts exactly 5 s and 50 MB', () => {
    const actor = actorIn('pickClip');
    actor.send({ type: 'CLIP_SELECTED', clip: { mimeType: 'video/mp4', durationSec: 5, sizeBytes: MAX_CLIP_BYTES } });
    expect(actor.getSnapshot().value).toBe('tracking');
  });

  it.each([
    ['no tracks', []],
    ['a ball tracked for only 29 frames', [{ ...ballTrack, frameCount: 29 }]],
    ['only blocks', [{ objectId: '2', kind: 'block', frameCount: 240 }]],
  ] as const)('TRACKS_READY needs a ball over 30 frames, not %s', (_why, tracks) => {
    const actor = actorIn('tracking');
    actor.send({ type: 'TRACKS_READY', tracks });
    expect(actor.getSnapshot().value).toBe('tracking');
  });

  it('TRACKS_READY accepts a ball tracked over exactly 30 frames', () => {
    const actor = actorIn('tracking');
    actor.send({ type: 'TRACKS_READY', tracks: [{ ...ballTrack, frameCount: 30 }] });
    expect(actor.getSnapshot().value).toBe('sceneReading');
  });

  it.each([
    ['invalid JSON shape', { ...FIXTURE_SCENE, ball: { center: { x: 1, y: 1 } } }],
    ['no scale found', { ...FIXTURE_SCENE, scaleMarkers: [{ x: 500, y: 660 }, { x: 501, y: 660 }] }],
    ['not an object', 'ramp at 30 degrees'],
  ])('SCENE_READY rejects %s', (_why, scene) => {
    const actor = actorIn('sceneReading');
    actor.send({ type: 'SCENE_READY', scene });
    expect(actor.getSnapshot().value).toBe('sceneReading');
  });

  it('FIT_DONE waits while RMS is above threshold and iterations remain', () => {
    const actor = actorIn('fitting');
    actor.send({ type: 'FIT_DONE', fit: { rms: 0.02, iterations: 39 } });
    expect(actor.getSnapshot().value).toBe('fitting');
  });

  it('FIT_DONE accepts a poor fit once max iterations are spent', () => {
    const actor = actorIn('fitting');
    actor.send({ type: 'FIT_DONE', fit: { rms: 0.02, iterations: 40 } });
    expect(actor.getSnapshot().value).toBe('frozen');
  });

  it('FIT_DONE rejects a non-finite RMS', () => {
    const actor = actorIn('fitting');
    actor.send({ type: 'FIT_DONE', fit: { rms: Number.NaN, iterations: 99 } });
    expect(actor.getSnapshot().value).toBe('fitting');
  });

  it.each([
    ['ramp steeper than 60°', { rampAngleDeg: 61, removeBlockIds: [] }],
    ['a block that is not in the scene', { rampAngleDeg: null, removeBlockIds: ['red'] }],
    ['an edit that changes nothing', { rampAngleDeg: null, removeBlockIds: [] }],
    ['garbage', { angle: 'steep' }],
  ])('APPLY_EDIT ignores %s', (_why, edit) => {
    const actor = actorIn('whatIf', reachedContext.whatIf);
    actor.send({ type: 'APPLY_EDIT', edit });
    expect(actor.getSnapshot().value).toBe('whatIf');
    expect(actor.getSnapshot().context.edits).toEqual([]);
  });
});

describe('AppFlow invalid events', () => {
  const allowed = new Set(table.map(([from, type]) => `${from}:${type}`));
  const cases = APP_FLOW_STATES.flatMap((state) =>
    Object.values(valid)
      .filter((event) => !allowed.has(`${state}:${event.type}`))
      .map((event) => [state, event.type, event] as const),
  );

  it.each(cases)('%s ignores %s', (state, _type, event) => {
    const actor = actorIn(state, reachedContext[state]);
    const before = actor.getSnapshot();
    actor.send(event);
    const after = actor.getSnapshot();
    expect(after.value).toBe(state);
    expect(after.context).toEqual(before.context);
  });
});

describe('AppFlow commitment', () => {
  it.each(['', 'not-a-hash', 'ABCDEF12', '1234567'])('PREDICTION_READY with hash %j stays in predicting', (hash) => {
    const actor = actorIn('predicting');
    actor.send({ type: 'PREDICTION_READY', commitmentHash: hash });
    expect(actor.getSnapshot().value).toBe('predicting');
    expect(actor.getSnapshot().context.commitmentHash).toBeNull();
  });

  it('PREDICT is the only way into predicting, and only from frozen', () => {
    const intoPredicting = table.filter(([, , to]) => to === 'predicting');
    expect(intoPredicting).toEqual([['frozen', 'PREDICT', 'predicting']]);
  });

  it('no random event sequence reaches a revealed state without a commitment hash', () => {
    const rand = createPrng(20261028);
    const events = Object.values(valid);
    const bad: AppFlowEvent[] = [
      { type: 'PREDICTION_READY', commitmentHash: '' },
      { type: 'PREDICTION_READY', commitmentHash: 'xyz' },
    ];
    const pool = [...events, ...bad, ...bad];
    let revealedSteps = 0;
    for (let run = 0; run < 2000; run++) {
      const actor = createActor(appFlowMachine, { input }).start();
      for (let step = 0; step < 60; step++) {
        actor.send(pool[Math.floor(rand() * pool.length)]!);
        const { value, context } = actor.getSnapshot();
        if (value === 'revealing' || value === 'result' || value === 'whatIf') {
          revealedSteps++;
          expect(context.commitmentHash).toMatch(/^[0-9a-f]{8,64}$/);
        }
      }
    }
    // Guard against a vacuous pass: the walk must actually get past predicting.
    expect(revealedSteps).toBeGreaterThan(0);
  });
});
