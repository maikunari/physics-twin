import { describe, expect, it } from 'vitest';
import { readWhatIfReply, validateEdit, whatIfAskSchema, whatIfSparkRequest, type WhatIfAsk } from './textEdit';

const ask: WhatIfAsk = { text: 'twice as steep and no blue block', rampAngleDeg: 20, blocks: [{ id: 'blue', label: 'blue block' }] };

/** A Responses API reply carrying `text` as its output message. */
const reply = (text: string) => ({ output: [{ type: 'message', content: [{ type: 'output_text', text }] }] });

describe('validateEdit (spec §6: impossible values are refused)', () => {
  it.each([
    ['an angle over 60°', { rampAngleDeg: 61, removeBlockIds: [] }, /rampAngleDeg/],
    ['a zero angle', { rampAngleDeg: 0, removeBlockIds: [] }, /rampAngleDeg/],
    ['a negative angle', { rampAngleDeg: -10, removeBlockIds: [] }, /rampAngleDeg/],
    ['an edit that changes nothing', { rampAngleDeg: null, removeBlockIds: [] }, /changes nothing/],
    ['a block the scene does not have', { rampAngleDeg: null, removeBlockIds: ['red'] }, /no block red/],
    ['extra fields', { rampAngleDeg: 30, removeBlockIds: [], ballRadius: -1 }, /refused/],
    ['not an object', 'steeper', /refused/],
  ])('refuses %s', (_name, edit, why) => {
    const checked = validateEdit(edit, ['blue']);
    expect(checked.ok).toBe(false);
    if (!checked.ok) expect(checked.error).toMatch(why);
  });

  it('accepts 60° and a known block', () => {
    expect(validateEdit({ rampAngleDeg: 60, removeBlockIds: ['blue'] }, ['blue'])).toEqual({
      ok: true,
      edit: { rampAngleDeg: 60, removeBlockIds: ['blue'] },
      note: '',
    });
  });
});

describe('the Muse Spark what-if request', () => {
  it('asks for strict structured output and gives the scene, not the footage', () => {
    const request = whatIfSparkRequest(ask);
    expect(request.model).toBe('muse-spark-1.3');
    expect(request.text.format).toMatchObject({ type: 'json_schema', strict: true, name: 'whatif_edit' });
    const schema = request.text.format.schema as { required?: string[]; additionalProperties?: boolean };
    expect(schema.required).toEqual(['rampAngleDeg', 'removeBlockIds', 'note']);
    expect(schema.additionalProperties).toBe(false);
    expect(request.input[0]?.content).toContain('Current ramp angle: 20.0°');
    expect(request.input[0]?.content).toContain('blue (blue block)');
    expect(request.input[0]?.content).toContain('What if: twice as steep and no blue block');
  });

  it('bounds the ask itself', () => {
    expect(whatIfAskSchema.safeParse({ ...ask, text: '   ' }).success).toBe(false);
    expect(whatIfAskSchema.safeParse({ ...ask, text: 'x'.repeat(301) }).success).toBe(false);
    expect(whatIfAskSchema.safeParse({ ...ask, extra: 1 }).success).toBe(false);
  });
});

describe('readWhatIfReply', () => {
  it('reads a valid edit and its note', () => {
    const answer = readWhatIfReply(reply('{"rampAngleDeg":40,"removeBlockIds":["blue"],"note":"40° is twice 20°"}'), ask);
    expect(answer).toEqual({ ok: true, edit: { rampAngleDeg: 40, removeBlockIds: ['blue'] }, note: '40° is twice 20°' });
  });

  it('refuses an angle past the limit instead of clamping it, with the model note', () => {
    const answer = readWhatIfReply(reply('{"rampAngleDeg":80,"removeBlockIds":[],"note":"four times as steep"}'), ask);
    expect(answer.ok).toBe(false);
    if (!answer.ok) expect(answer.error).toMatch(/rampAngleDeg.*Muse Spark: four times as steep/);
  });

  it.each([
    ['an invented block', '{"rampAngleDeg":null,"removeBlockIds":["green"],"note":""}', /no block green/],
    ['a request it cannot express', '{"rampAngleDeg":null,"removeBlockIds":[],"note":"cannot add a cup"}', /changes nothing.*cannot add a cup/],
    ['text that is not JSON', 'sure, 40 degrees', /not reply with JSON/],
    ['JSON of another shape', '{"angle":40}', /something other than an edit/],
  ])('refuses %s', (_name, text, why) => {
    const answer = readWhatIfReply(reply(text), ask);
    expect(answer.ok).toBe(false);
    if (!answer.ok) expect(answer.error).toMatch(why);
  });

  it('refuses a reply that is not a Responses object', () => {
    expect(readWhatIfReply({ nope: true }, ask).ok).toBe(false);
  });
});
