import { beforeAll, describe, expect, it } from 'vitest';
import { FIXTURE_IMAGE_SIZE, FIXTURE_SCENE } from '../scene/fixtures';
import { initRapier } from '../sim/sceneWorld';
import { SYNTHETIC_MEASUREMENT, syntheticTruth } from '../synthetic/syntheticProblem';
import { makeSyntheticTake, type SyntheticTake } from '../synthetic/syntheticTake';
import { formatSamFrameLine } from '../tracks/samText';
import { verifyCommitment } from './commitment';
import { runTake, type TakeRun } from './takeRun';

const FPS = 240;
const TRUTH = syntheticTruth(0.08, 0.55);
const sceneJson = JSON.stringify({ source: 'fixture', imageSize: FIXTURE_IMAGE_SIZE, markerDistanceCm: 50, scene: FIXTURE_SCENE });

let take: SyntheticTake;
let run: TakeRun;
const order: string[] = [];
beforeAll(async () => {
  await initRapier();
  take = makeSyntheticTake(FIXTURE_SCENE, FIXTURE_IMAGE_SIZE, TRUTH, { durationSec: 2.2, releaseDelaySec: 0.5, seed: 3, ...SYNTHETIC_MEASUREMENT });
  run = await runTake({
    take: 'A01',
    sceneJson,
    samText: take.samText,
    fps: FPS,
    onLog: () => order.push('log'),
    onCommit: () => {
      order.push('commit');
    },
  });
}, 60_000);

/**
 * The same take with the ball's box moved somewhere else on every frame from
 * `fromSec` after the release on: what a different reality after the freeze
 * looks like to the pipeline.
 */
function rewriteAfter(fromSec: number): string {
  const cut = take.releaseFrame + Math.round(fromSec * FPS);
  return take.samText
    .split('\n')
    .map((line) => {
      const frame = Number(/^<(\d+)f>/.exec(line)?.[1] ?? -1);
      if (frame <= cut) return line;
      const p = take.ballPx[frame];
      if (!p) return line;
      const box = { left: Math.round(p.x - 300), top: Math.round(p.y - 200), right: Math.round(p.x - 280), bottom: Math.round(p.y - 180) };
      return formatSamFrameLine(frame, [{ objectId: '1', box, confidence: 0.9 }], FIXTURE_IMAGE_SIZE).trimEnd();
    })
    .join('\n');
}

describe('runTake', () => {
  it('fits, predicts, commits and then reveals one take', async () => {
    expect(run.take).toBe('A01');
    expect(run.releaseSec).toBeCloseTo(0.5, 2);
    expect(run.fit.best.rmsCm).toBeLessThan(0.15);
    expect(run.prediction.freezeSec).toBe(1);
    expect(run.outcome.commitmentHash).toBe(run.commitment.hash);
    expect(await verifyCommitment(run.commitment, run.prediction)).toBe(true);
    // The fit logs first, then the commitment is handed out before anything is scored.
    expect(order.at(-1)).toBe('commit');
    expect(order.indexOf('commit')).toBe(order.length - 1);
  });

  it('predicts the synthetic take it was fitted on to within millimetres and milliseconds, inside the band', () => {
    const { event } = run.outcome;
    expect(event.real?.kind).toBe(run.prediction.band.kind);
    expect(event.errorCm).toBeLessThan(0.5);
    expect(Math.abs(event.errorMs ?? Infinity)).toBeLessThan(5);
    expect(event.insideBand).toBe(true);
  });

  it('no peeking: a different reality after the freeze leaves the commitment unchanged and only moves the score', async () => {
    const other = await runTake({ take: 'A01', sceneJson, samText: rewriteAfter(1.05), fps: FPS });
    expect(other.commitment.hash).toBe(run.commitment.hash);
    expect(other.prediction).toEqual(run.prediction);
    expect(other.fit.best).toEqual(run.fit.best);
    expect(other.outcome.trajectory.rmsMm).toBeGreaterThan(100);
  }, 60_000);
});
