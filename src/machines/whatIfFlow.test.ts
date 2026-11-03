import { describe, expect, it } from 'vitest';
import { createActor } from 'xstate';
import type { WhatIfEdit } from '../scene/whatIfEdit';
import type { WhatIfRun } from '../whatif/run';
import { WHAT_IF_FLOW_STATES, whatIfFlowMachine, type WhatIfFlowEvent, type WhatIfFlowState } from './whatIfFlow';

const STEEPER: WhatIfEdit = { rampAngleDeg: 32, removeBlockIds: [] };
const NO_BLOCK: WhatIfEdit = { rampAngleDeg: null, removeBlockIds: ['blue'] };

/** A stand-in run: the machine only reads which edit it was made for. */
const runOf = (edit: WhatIfEdit) => ({ edit }) as unknown as WhatIfRun;

function start(...events: WhatIfFlowEvent[]) {
  const actor = createActor(whatIfFlowMachine, { input: { blockIds: ['blue'] } }).start();
  for (const e of events) actor.send(e);
  return actor;
}

const stateOf = (actor: ReturnType<typeof start>) => actor.getSnapshot().value as WhatIfFlowState;

/** Reaches each state with a real sequence of events. */
const REACH: Record<WhatIfFlowState, WhatIfFlowEvent[]> = {
  idle: [],
  asking: [{ type: 'ASK', text: 'steeper' }],
  running: [{ type: 'SET_EDIT', edit: STEEPER }],
  shown: [{ type: 'SET_EDIT', edit: STEEPER }, { type: 'RUN_DONE', run: runOf(STEEPER) }],
  failed: [{ type: 'ASK', text: 'steeper' }, { type: 'ASK_FAILED', error: '/api/whatif answered 503' }],
};

describe('whatIfFlow transitions', () => {
  it.each([
    ['idle', { type: 'SET_EDIT', edit: STEEPER }, 'running'],
    ['idle', { type: 'ASK', text: 'twice as steep' }, 'asking'],
    ['asking', { type: 'ANSWER', edit: NO_BLOCK, note: '' }, 'running'],
    ['asking', { type: 'ANSWER', edit: { rampAngleDeg: 75, removeBlockIds: [] }, note: '' }, 'failed'],
    ['asking', { type: 'ASK_FAILED', error: 'rate limit' }, 'failed'],
    ['asking', { type: 'CLEAR' }, 'idle'],
    ['running', { type: 'RUN_DONE', run: runOf(STEEPER) }, 'shown'],
    ['running', { type: 'RUN_FAILED', error: 'boom' }, 'failed'],
    ['running', { type: 'SET_EDIT', edit: NO_BLOCK }, 'running'],
    ['shown', { type: 'SET_EDIT', edit: NO_BLOCK }, 'running'],
    ['shown', { type: 'ASK', text: 'no blue block' }, 'asking'],
    ['shown', { type: 'CLEAR' }, 'idle'],
    ['failed', { type: 'SET_EDIT', edit: STEEPER }, 'running'],
    ['failed', { type: 'ASK', text: 'again' }, 'asking'],
    ['failed', { type: 'CLEAR' }, 'idle'],
  ] as [WhatIfFlowState, WhatIfFlowEvent, WhatIfFlowState][])('%s --%o--> %s', (from, event, to) => {
    const actor = start(...REACH[from]);
    expect(stateOf(actor)).toBe(from);
    actor.send(event);
    expect(stateOf(actor)).toBe(to);
  });

  it('covers every state', () => {
    expect(Object.keys(REACH).sort()).toEqual([...WHAT_IF_FLOW_STATES].sort());
  });
});

describe('whatIfFlow guards', () => {
  it.each([
    ['an angle over 60°', { rampAngleDeg: 61, removeBlockIds: [] }],
    ['a negative angle', { rampAngleDeg: -5, removeBlockIds: [] }],
    ['an unknown block', { rampAngleDeg: null, removeBlockIds: ['red'] }],
    ['an empty edit', { rampAngleDeg: null, removeBlockIds: [] }],
  ])('ignores a slider edit with %s', (_name, edit) => {
    for (const from of ['idle', 'shown', 'failed'] as const) {
      const actor = start(...REACH[from]);
      actor.send({ type: 'SET_EDIT', edit });
      expect(stateOf(actor)).toBe(from);
    }
  });

  it('fails a Muse Spark edit that breaks a rule, keeping the reason and the note', () => {
    const actor = start({ type: 'ASK', text: 'four times as steep' }, { type: 'ANSWER', edit: { rampAngleDeg: 80, removeBlockIds: [] }, note: '4 × 20°' });
    expect(stateOf(actor)).toBe('failed');
    expect(actor.getSnapshot().context.error).toMatch(/rampAngleDeg/);
    expect(actor.getSnapshot().context.note).toBe('4 × 20°');
    expect(actor.getSnapshot().context.edit).toBeNull();
  });

  it('ignores a blank question', () => {
    expect(stateOf(start({ type: 'ASK', text: '   ' }))).toBe('idle');
  });

  it('shows only the run of the current edit', () => {
    const actor = start({ type: 'SET_EDIT', edit: STEEPER }, { type: 'SET_EDIT', edit: { rampAngleDeg: 40, removeBlockIds: [] } });
    actor.send({ type: 'RUN_DONE', run: runOf(STEEPER) });
    expect(stateOf(actor)).toBe('running');
    actor.send({ type: 'RUN_DONE', run: runOf({ rampAngleDeg: 40, removeBlockIds: [] }) });
    expect(stateOf(actor)).toBe('shown');
    expect(actor.getSnapshot().context.run?.edit.rampAngleDeg).toBe(40);
  });

  it('records where the edit came from', () => {
    const slider = start(...REACH.shown);
    expect(slider.getSnapshot().context).toMatchObject({ source: 'slider', edit: STEEPER });
    const text = start({ type: 'ASK', text: '  no blue block  ' }, { type: 'ANSWER', edit: NO_BLOCK, note: 'removes blue' });
    expect(text.getSnapshot().context).toMatchObject({ source: 'text', text: 'no blue block', note: 'removes blue', edit: NO_BLOCK });
  });

  it.each([
    ['idle', { type: 'RUN_DONE', run: runOf(STEEPER) }],
    ['idle', { type: 'ANSWER', edit: STEEPER, note: '' }],
    ['asking', { type: 'SET_EDIT', edit: STEEPER }],
    ['asking', { type: 'RUN_DONE', run: runOf(STEEPER) }],
    ['running', { type: 'ASK', text: 'steeper' }],
    ['running', { type: 'CLEAR' }],
    ['shown', { type: 'ANSWER', edit: STEEPER, note: '' }],
    ['failed', { type: 'RUN_DONE', run: runOf(STEEPER) }],
  ] as [WhatIfFlowState, WhatIfFlowEvent][])('ignores in %s: %o', (from, event) => {
    const actor = start(...REACH[from]);
    const before = actor.getSnapshot().context;
    actor.send(event);
    expect(stateOf(actor)).toBe(from);
    expect(actor.getSnapshot().context).toEqual(before);
  });

  it('a late Muse Spark answer after CLEAR changes nothing', () => {
    const actor = start({ type: 'ASK', text: 'steeper' }, { type: 'CLEAR' });
    actor.send({ type: 'ANSWER', edit: STEEPER, note: '' });
    expect(stateOf(actor)).toBe('idle');
    expect(actor.getSnapshot().context.edit).toBeNull();
  });
});
