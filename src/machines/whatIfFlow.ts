import { assign, setup } from 'xstate';
import type { WhatIfEdit } from '../scene/whatIfEdit';
import { MAX_WHATIF_TEXT, validateEdit } from '../whatif/textEdit';
import type { WhatIfRun } from '../whatif/run';

export type EditSource = 'slider' | 'text';

export interface WhatIfFlowInput {
  /** The frozen scene's block ids: an edit may only remove these. */
  readonly blockIds: readonly string[];
}

export interface WhatIfFlowContext extends WhatIfFlowInput {
  readonly edit: WhatIfEdit | null;
  readonly source: EditSource | null;
  /** The typed what-if, while Muse Spark reads it and after. */
  readonly text: string | null;
  /** Muse Spark's one-line note on how it read the text. */
  readonly note: string | null;
  readonly run: WhatIfRun | null;
  readonly error: string | null;
}

export type WhatIfFlowEvent =
  | { type: 'SET_EDIT'; edit: unknown }
  | { type: 'ASK'; text: string }
  | { type: 'ANSWER'; edit: unknown; note: string }
  | { type: 'ASK_FAILED'; error: string }
  | { type: 'RUN_DONE'; run: WhatIfRun }
  | { type: 'RUN_FAILED'; error: string }
  | { type: 'CLEAR' };

export const WHAT_IF_FLOW_STATES = ['idle', 'asking', 'running', 'shown', 'failed'] as const;
export type WhatIfFlowState = (typeof WHAT_IF_FLOW_STATES)[number];

const sameEdit = (a: WhatIfEdit | null, b: WhatIfEdit) =>
  a !== null && a.rampAngleDeg === b.rampAngleDeg && a.removeBlockIds.join('\n') === b.removeBlockIds.join('\n');

const cleared = { edit: null, source: null, text: null, note: null, run: null, error: null } as const;

const askText = (text: string) => text.trim().slice(0, MAX_WHATIF_TEXT);

/**
 * The what-if step after a reveal (spec §6.1 result → whatIf, APPLY_EDIT):
 *
 * - idle: the fit and the frozen scene, no edit yet.
 * - asking: Muse Spark is turning a typed what-if into an edit (`/api/whatif`).
 * - running: the edited scene is simulated with the fitted parameters.
 * - shown: the amber run is on the overlay.
 * - failed: the text could not be turned into a valid edit, or the run failed.
 *
 * Every edit, from a slider or from Muse Spark, passes the same check (zod
 * schema plus the scene's block ids) before it runs: an invalid slider edit
 * is ignored, an invalid Muse Spark edit fails with the reason. A run only
 * shows if it is the run of the current edit, so a slow run for an old
 * slider position cannot overwrite a newer one.
 */
export const whatIfFlowMachine = setup({
  types: {
    context: {} as WhatIfFlowContext,
    events: {} as WhatIfFlowEvent,
    input: {} as WhatIfFlowInput,
  },
  guards: {
    editValid: ({ context, event }) =>
      (event.type === 'SET_EDIT' || event.type === 'ANSWER') && validateEdit(event.edit, context.blockIds).ok,
    hasText: ({ event }) => event.type === 'ASK' && askText(event.text).length > 0,
    currentRun: ({ context, event }) => event.type === 'RUN_DONE' && sameEdit(context.edit, event.run.edit),
  },
  actions: {
    takeSliderEdit: assign(({ context, event }) => {
      if (event.type !== 'SET_EDIT') return {};
      const checked = validateEdit(event.edit, context.blockIds);
      return checked.ok ? { ...cleared, edit: checked.edit, source: 'slider' as const } : {};
    }),
  },
}).createMachine({
  id: 'whatIfFlow',
  initial: 'idle',
  context: ({ input }) => ({ ...input, ...cleared }),
  states: {
    idle: {
      on: {
        SET_EDIT: { guard: 'editValid', target: 'running', actions: 'takeSliderEdit' },
        ASK: { guard: 'hasText', target: 'asking', actions: assign({ ...cleared, text: ({ event }) => askText(event.text) }) },
      },
    },
    asking: {
      on: {
        ANSWER: [
          {
            guard: 'editValid',
            target: 'running',
            actions: assign(({ context, event }) => {
              const checked = validateEdit(event.edit, context.blockIds);
              return checked.ok ? { edit: checked.edit, source: 'text' as const, note: event.note, run: null, error: null } : {};
            }),
          },
          {
            target: 'failed',
            actions: assign(({ context, event }) => {
              const checked = validateEdit(event.edit, context.blockIds);
              return { note: event.note, error: checked.ok ? null : checked.error };
            }),
          },
        ],
        ASK_FAILED: { target: 'failed', actions: assign({ error: ({ event }) => event.error }) },
        CLEAR: { target: 'idle', actions: assign(cleared) },
      },
    },
    running: {
      on: {
        // A slider moved again before the last run finished: run the new edit instead.
        SET_EDIT: { guard: 'editValid', target: 'running', reenter: true, actions: 'takeSliderEdit' },
        RUN_DONE: { guard: 'currentRun', target: 'shown', actions: assign({ run: ({ event }) => event.run }) },
        RUN_FAILED: { target: 'failed', actions: assign({ error: ({ event }) => event.error }) },
      },
    },
    shown: {
      on: {
        SET_EDIT: { guard: 'editValid', target: 'running', actions: 'takeSliderEdit' },
        ASK: { guard: 'hasText', target: 'asking', actions: assign({ ...cleared, text: ({ event }) => askText(event.text) }) },
        CLEAR: { target: 'idle', actions: assign(cleared) },
      },
    },
    failed: {
      on: {
        SET_EDIT: { guard: 'editValid', target: 'running', actions: 'takeSliderEdit' },
        ASK: { guard: 'hasText', target: 'asking', actions: assign({ ...cleared, text: ({ event }) => askText(event.text) }) },
        CLEAR: { target: 'idle', actions: assign(cleared) },
      },
    },
  },
});
