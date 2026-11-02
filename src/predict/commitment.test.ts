import { beforeAll, describe, expect, it } from 'vitest';
import { initRapier } from '../sim/sceneWorld';
import { syntheticFitCase, syntheticTruth } from '../synthetic/syntheticProblem';
import { SHORT_HASH_LENGTH, commitPrediction, commitmentPayload, isCommitmentHash, sha256Hex, verifyCommitment } from './commitment';
import { makePrediction, type Prediction } from './prediction';

let prediction: Prediction;
beforeAll(async () => {
  await initRapier();
  const truth = syntheticTruth(0.08, 0.55);
  const { problem } = syntheticFitCase(truth, 1, 2.2);
  prediction = makePrediction(problem, { params: truth, timeShiftSec: 0, rmsCm: 0.086 });
});

describe('commitment', () => {
  it('is the SHA-256 of the canonical prediction', async () => {
    expect(await sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    const c = await commitPrediction('A01', prediction, new Date('2026-10-31T12:00:00Z'));
    expect(isCommitmentHash(c.hash)).toBe(true);
    expect(c.short).toBe(c.hash.slice(0, SHORT_HASH_LENGTH));
    expect(c.payload).toBe(commitmentPayload('A01', prediction));
    expect(c.hash).toBe(await sha256Hex(c.payload));
    expect(c.committedAt).toBe('2026-10-31T12:00:00.000Z');
  });

  it('does not depend on when it was made, only on what it says', async () => {
    const a = await commitPrediction('A01', prediction, new Date(0));
    const b = await commitPrediction('A01', structuredClone(prediction), new Date());
    expect(b.hash).toBe(a.hash);
  });

  it('changes with the take or any committed number', async () => {
    const base = (await commitPrediction('A01', prediction)).hash;
    expect((await commitPrediction('A02', prediction)).hash).not.toBe(base);
    const moved: Prediction = { ...prediction, nominal: { ...prediction.nominal, event: { ...prediction.nominal.event, x: prediction.nominal.event.x + 0.01 } } };
    expect((await commitPrediction('A01', moved)).hash).not.toBe(base);
    const member = prediction.members[3]!;
    const nudged: Prediction = {
      ...prediction,
      members: prediction.members.map((m) => (m === member ? { ...m, params: { ...m.params, restitution: m.params.restitution + 0.001 } } : m)),
    };
    expect((await commitPrediction('A01', nudged)).hash).not.toBe(base);
  });

  it('verifies against the prediction it was made from, and nothing else', async () => {
    const c = await commitPrediction('A01', prediction);
    expect(await verifyCommitment(c, prediction)).toBe(true);
    const later: Prediction = { ...prediction, band: { ...prediction.band, x: [prediction.band.x[0] - 5, prediction.band.x[1] + 5] } };
    expect(await verifyCommitment(c, later)).toBe(false);
    expect(await verifyCommitment({ ...c, hash: c.hash.replace(/^./, c.hash[0] === 'a' ? 'b' : 'a') }, prediction)).toBe(false);
  });

  it('accepts only full lowercase hex hashes', () => {
    expect(isCommitmentHash('a'.repeat(64))).toBe(true);
    expect(isCommitmentHash('a'.repeat(12))).toBe(false);
    expect(isCommitmentHash('A'.repeat(64))).toBe(false);
  });
});
