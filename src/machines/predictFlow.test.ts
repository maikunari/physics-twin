import { describe, expect, it } from 'vitest';
import { createActor } from 'xstate';
import type { Commitment } from '../predict/commitment';
import type { Prediction } from '../predict/prediction';
import type { RevealOutcome } from '../predict/reveal';
import {
  PREDICT_FLOW_STATES,
  predictFlowMachine,
  type PredictFlowContext,
  type PredictFlowEvent,
  type PredictFlowState,
} from './predictFlow';

// The machine only carries these; their contents are tested in src/predict.
const prediction = { freezeSec: 1 } as unknown as Prediction;
const HASH = '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08';
const commitment: Commitment = { take: 'A01', hash: HASH, short: HASH.slice(0, 12), payload: '{"v":1}', committedAt: '2026-10-31T12:00:00.000Z' };
const outcome = { commitmentHash: HASH } as unknown as RevealOutcome;

const empty: PredictFlowContext = { prediction: null, commitment: null, outcome: null, error: null };
const committedContext: PredictFlowContext = { ...empty, prediction, commitment };

/** Context a state can only be in after the steps before it ran. */
const reached: Record<PredictFlowState, PredictFlowContext> = {
  frozen: empty,
  predicting: empty,
  committed: committedContext,
  revealing: committedContext,
  result: { ...committedContext, outcome },
  failed: { ...empty, error: 'the clip ends at the freeze' },
};

function actorIn(state: PredictFlowState, context: PredictFlowContext = reached[state]) {
  const snapshot = predictFlowMachine.resolveState({ value: state, context });
  return createActor(predictFlowMachine, { snapshot }).start();
}

const valid: Record<PredictFlowEvent['type'], PredictFlowEvent> = {
  PREDICT: { type: 'PREDICT' },
  PREDICTION_READY: { type: 'PREDICTION_READY', prediction, commitment },
  PREDICTION_FAILED: { type: 'PREDICTION_FAILED', error: 'the clip ends at the freeze' },
  REVEAL: { type: 'REVEAL' },
  REVEAL_DONE: { type: 'REVEAL_DONE', outcome },
  RESET: { type: 'RESET' },
};

const table: [PredictFlowState, PredictFlowEvent['type'], PredictFlowState][] = [
  ['frozen', 'PREDICT', 'predicting'],
  ['predicting', 'PREDICTION_READY', 'committed'],
  ['predicting', 'PREDICTION_FAILED', 'failed'],
  ['committed', 'REVEAL', 'revealing'],
  ['committed', 'RESET', 'frozen'],
  ['revealing', 'REVEAL_DONE', 'result'],
  ['revealing', 'RESET', 'frozen'],
  ['result', 'RESET', 'frozen'],
  ['failed', 'RESET', 'frozen'],
];

describe('PredictFlow transition table', () => {
  it.each(table)('%s --%s--> %s', (from, type, to) => {
    const actor = actorIn(from);
    actor.send(valid[type]);
    expect(actor.getSnapshot().value).toBe(to);
  });

  it('ignores every event not in the table', () => {
    const allowed = new Set(table.map(([from, type]) => `${from}:${type}`));
    for (const state of PREDICT_FLOW_STATES) {
      for (const event of Object.values(valid)) {
        if (allowed.has(`${state}:${event.type}`)) continue;
        const actor = actorIn(state);
        actor.send(event);
        expect(actor.getSnapshot().value, `${state} on ${event.type}`).toBe(state);
        expect(actor.getSnapshot().context).toEqual(reached[state]);
      }
    }
  });

  it('carries the prediction, its commitment and the outcome through a whole run', () => {
    const actor = createActor(predictFlowMachine).start();
    for (const type of ['PREDICT', 'PREDICTION_READY', 'REVEAL', 'REVEAL_DONE'] as const) actor.send(valid[type]);
    const { value, context } = actor.getSnapshot();
    expect(value).toBe('result');
    expect(context).toEqual({ prediction, commitment, outcome, error: null });
  });

  it('RESET clears the old prediction so the next one commits afresh', () => {
    for (const state of ['committed', 'revealing', 'result', 'failed'] as const) {
      const actor = actorIn(state);
      actor.send(valid.RESET);
      expect(actor.getSnapshot().context).toEqual(empty);
    }
  });
});

describe('PredictFlow guards', () => {
  it('cannot reveal without a commitment', () => {
    const actor = actorIn('committed', { ...empty, prediction });
    actor.send(valid.REVEAL);
    expect(actor.getSnapshot().value).toBe('committed');
  });

  it.each([
    ['a short hash', { ...commitment, hash: HASH.slice(0, 12) }],
    ['an uppercase hash', { ...commitment, hash: HASH.toUpperCase() }],
    ['an empty payload', { ...commitment, payload: '' }],
  ])('refuses a commitment with %s', (_why, bad) => {
    const actor = actorIn('predicting');
    actor.send({ type: 'PREDICTION_READY', prediction, commitment: bad });
    expect(actor.getSnapshot().value).toBe('predicting');
  });

  it('refuses an outcome that scores a different commitment', () => {
    const actor = actorIn('revealing');
    actor.send({ type: 'REVEAL_DONE', outcome: { ...outcome, commitmentHash: 'a'.repeat(64) } });
    expect(actor.getSnapshot().value).toBe('revealing');
    expect(actor.getSnapshot().context.outcome).toBeNull();
  });

  it('records why a prediction failed', () => {
    const actor = actorIn('predicting');
    actor.send(valid.PREDICTION_FAILED);
    expect(actor.getSnapshot().context.error).toBe('the clip ends at the freeze');
  });
});
