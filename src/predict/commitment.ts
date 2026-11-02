import type { SimParams } from '../sim/params';
import type { PathPoint } from './events';
import type { Prediction } from './prediction';

/** Characters of the hash shown on screen and in the results table; the full hash is kept alongside. */
export const SHORT_HASH_LENGTH = 12;

/**
 * A published prediction (spec §5, "no peeking"): the SHA-256 of the
 * prediction's canonical text, shown and logged at the freeze, before the
 * clip plays on. Anyone can recompute it from the prediction afterwards and
 * check it was not changed after the reveal.
 */
export interface Commitment {
  /** Which take this prediction is for, so a commitment cannot be passed off for another one. */
  readonly take: string;
  /** Lowercase hex SHA-256 of `payload`. */
  readonly hash: string;
  readonly short: string;
  /** The canonical text that was hashed. */
  readonly payload: string;
  /** Wall-clock time of the commitment, ISO 8601. Not part of the hash. */
  readonly committedAt: string;
}

const round = (v: number, digits: number) => Number(v.toFixed(digits));
const cm = (p: PathPoint) => ({ t: round(p.t, 4), x: round(p.x, 3), y: round(p.y, 3) });
const params = (p: SimParams) => ({
  muRamp: round(p.muRamp, 6),
  muTable: round(p.muTable, 6),
  restitution: round(p.restitution, 6),
  rollingDamping: round(p.rollingDamping, 6),
  v0: round(p.v0, 6),
  omega0: round(p.omega0, 6),
});

/**
 * The canonical text of a prediction: fixed key order, numbers rounded past
 * anything the reveal measures (0.1 ms, 0.01 mm), so the same prediction
 * always hashes the same on any machine. Holds what the prediction says will
 * happen and the parameters of every run that says it; the drawn paths follow
 * from those and are left out.
 */
export function commitmentPayload(take: string, prediction: Prediction): string {
  const { nominal, band } = prediction;
  return JSON.stringify({
    v: 1,
    take,
    freezeSec: round(prediction.freezeSec, 4),
    horizonEndSec: round(prediction.horizonEndSec, 4),
    nominal: {
      params: params(nominal.params),
      timeShiftSec: round(nominal.timeShiftSec, 6),
      event: { kind: nominal.event.kind, ...cm(nominal.event) },
      end: cm(nominal.end),
    },
    band: {
      kind: band.kind,
      agreeing: band.agreeing,
      total: band.total,
      x: band.x.map((v) => round(v, 3)),
      t: band.t.map((v) => round(v, 4)),
    },
    members: prediction.members.map((m) => ({
      params: params(m.params),
      timeShiftSec: round(m.timeShiftSec, 6),
      event: m.event ? { kind: m.event.kind, ...cm(m.event) } : null,
    })),
  });
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function commitPrediction(take: string, prediction: Prediction, now: Date = new Date()): Promise<Commitment> {
  const payload = commitmentPayload(take, prediction);
  const hash = await sha256Hex(payload);
  return { take, hash, short: hash.slice(0, SHORT_HASH_LENGTH), payload, committedAt: now.toISOString() };
}

/** True when `commitment` is the hash of this prediction for this take. */
export async function verifyCommitment(commitment: Commitment, prediction: Prediction): Promise<boolean> {
  const payload = commitmentPayload(commitment.take, prediction);
  return payload === commitment.payload && (await sha256Hex(payload)) === commitment.hash;
}

/** A commitment hash is 64 lowercase hex characters. */
export const isCommitmentHash = (hash: string) => /^[0-9a-f]{64}$/.test(hash);
