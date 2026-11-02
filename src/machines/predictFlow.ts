import { assign, setup } from 'xstate';
import { isCommitmentHash, type Commitment } from '../predict/commitment';
import type { Prediction } from '../predict/prediction';
import type { RevealOutcome } from '../predict/reveal';

export interface PredictFlowContext {
  readonly prediction: Prediction | null;
  readonly commitment: Commitment | null;
  readonly outcome: RevealOutcome | null;
  readonly error: string | null;
}

export type PredictFlowEvent =
  | { type: 'PREDICT' }
  | { type: 'PREDICTION_READY'; prediction: Prediction; commitment: Commitment }
  | { type: 'PREDICTION_FAILED'; error: string }
  | { type: 'REVEAL' }
  | { type: 'REVEAL_DONE'; outcome: RevealOutcome }
  | { type: 'RESET' };

export const PREDICT_FLOW_STATES = ['frozen', 'predicting', 'committed', 'revealing', 'result', 'failed'] as const;
export type PredictFlowState = (typeof PREDICT_FLOW_STATES)[number];

const cleared = { prediction: null, commitment: null, outcome: null, error: null } as const;

/**
 * The predict step of AppFlow (spec §5, §6.1 frozen → predicting → revealing
 * → result), with the commitment as its own state so the hash is on screen
 * before any footage past the freeze plays:
 *
 * - frozen: the fit is done and its parameters are fixed; the clip is held at the freeze.
 * - predicting: the ensemble runs and the prediction is hashed.
 * - committed: the hash is published; the clip is still held.
 * - revealing: the clip plays on past the freeze.
 * - result: the errors against the footage are shown.
 * - failed: the prediction could not be made (say, the clip ends at the freeze).
 *
 * The reveal cannot start without a commitment, and an outcome only counts
 * if it scores the committed hash.
 */
export const predictFlowMachine = setup({
  types: {
    context: {} as PredictFlowContext,
    events: {} as PredictFlowEvent,
  },
  guards: {
    committedProperly: ({ event }) =>
      event.type === 'PREDICTION_READY' && isCommitmentHash(event.commitment.hash) && event.commitment.payload.length > 0,
    hasCommitment: ({ context }) => context.commitment !== null && context.prediction !== null,
    scoresCommitment: ({ context, event }) =>
      event.type === 'REVEAL_DONE' && context.commitment !== null && event.outcome.commitmentHash === context.commitment.hash,
  },
}).createMachine({
  id: 'predictFlow',
  initial: 'frozen',
  context: { ...cleared },
  states: {
    frozen: {
      on: { PREDICT: { target: 'predicting', actions: assign(cleared) } },
    },
    predicting: {
      on: {
        PREDICTION_READY: {
          guard: 'committedProperly',
          target: 'committed',
          actions: assign({
            prediction: ({ event }) => event.prediction,
            commitment: ({ event }) => event.commitment,
          }),
        },
        PREDICTION_FAILED: { target: 'failed', actions: assign({ error: ({ event }) => event.error }) },
      },
    },
    committed: {
      on: {
        REVEAL: { guard: 'hasCommitment', target: 'revealing' },
        RESET: { target: 'frozen', actions: assign(cleared) },
      },
    },
    revealing: {
      on: {
        REVEAL_DONE: { guard: 'scoresCommitment', target: 'result', actions: assign({ outcome: ({ event }) => event.outcome }) },
        RESET: { target: 'frozen', actions: assign(cleared) },
      },
    },
    result: {
      on: { RESET: { target: 'frozen', actions: assign(cleared) } },
    },
    failed: {
      on: { RESET: { target: 'frozen', actions: assign(cleared) } },
    },
  },
});
