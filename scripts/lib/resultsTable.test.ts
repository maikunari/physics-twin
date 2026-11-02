import { beforeAll, describe, expect, it } from 'vitest';
import { runTake, type TakeRun } from '../../src/predict/takeRun';
import { FIXTURE_IMAGE_SIZE, FIXTURE_SCENE } from '../../src/scene/fixtures';
import { initRapier } from '../../src/sim/sceneWorld';
import { SYNTHETIC_MEASUREMENT, syntheticTruth } from '../../src/synthetic/syntheticProblem';
import { makeSyntheticTake } from '../../src/synthetic/syntheticTake';
import { COLUMNS, setOf, summarise, toCsv, toMarkdown, type ResultRow } from './resultsTable';

let run: TakeRun;
beforeAll(async () => {
  await initRapier();
  const take = makeSyntheticTake(FIXTURE_SCENE, FIXTURE_IMAGE_SIZE, syntheticTruth(0.08, 0.55), {
    durationSec: 2.2,
    releaseDelaySec: 0.5,
    seed: 5,
    ...SYNTHETIC_MEASUREMENT,
  });
  run = await runTake({
    take: 'A01',
    sceneJson: JSON.stringify({ imageSize: FIXTURE_IMAGE_SIZE, markerDistanceCm: 50, scene: FIXTURE_SCENE }),
    samText: take.samText,
    fps: 240,
  });
}, 60_000);

/** A second run that missed its event entirely, as a bad take would. */
const missed = (r: TakeRun): TakeRun => ({
  ...r,
  take: 'B01',
  outcome: {
    ...r.outcome,
    event: { ...r.outcome.event, real: null, errorCm: null, errorPx: null, errorMs: null, insideBandX: null, insideBandT: null, insideBand: false },
  },
});

const rows = (): ResultRow[] => [
  { status: 'ok', take: 'A01', set: 'A', note: 'synthetic take (true μ ramp 0.08, e 0.55)', fps: 240, run },
  { status: 'ok', take: 'B01', set: 'B', note: '', fps: 240, run: missed(run) },
  { status: 'excluded', take: 'B02', set: 'B', note: 'not tracked: no sam-raw.txt in B02/' },
  { status: 'failed', take: 'C01', set: 'C', note: 'no ball track' },
];

describe('results table', () => {
  it('reads the set from the filming guide take names', () => {
    expect(setOf('A01')).toBe('A');
    expect(setOf('c10')).toBe('C');
    expect(setOf('take1')).toBe('-');
  });

  it('writes one CSV line per take found, the ones left out included, quoting where needed', () => {
    const lines = toCsv(rows()).trimEnd().split('\n');
    expect(lines).toHaveLength(5);
    expect(lines[0]!.split(',')).toEqual(COLUMNS.map(([h]) => h));
    expect(lines[1]).toContain('"synthetic take (true μ ramp 0.08, e 0.55)"');
    expect(lines[1]).toContain(run.commitment.hash);
    expect(lines[3]).toBe(`B02,B,excluded,not tracked: no sam-raw.txt in B02/${','.repeat(COLUMNS.length - 4)}`);
    expect(lines[4]!.startsWith('C01,C,failed,no ball track,')).toBe(true);
    // A run whose event never happened is listed as outside the band, not dropped.
    const header = lines[0]!.split(',');
    expect(lines[2]!.split(',')[header.indexOf('inside_band')]).toBe('no');
  });

  it('summarises every run per set and overall, misses counted', () => {
    const [a, b, c, all] = summarise(rows());
    expect(a).toMatchObject({ set: 'A', found: 1, ran: 1, insideBand: 1, eventMissed: 0 });
    expect(a!.meanEventErrCm).toBeCloseTo(run.outcome.event.errorCm!, 9);
    expect(b).toMatchObject({ set: 'B', found: 2, ran: 1, excluded: 1, insideBand: 0, eventMissed: 1, meanEventErrCm: null });
    expect(c).toMatchObject({ set: 'C', found: 1, ran: 0, failed: 1 });
    expect(all).toMatchObject({ set: 'all', found: 4, ran: 2, excluded: 1, failed: 1, insideBand: 1, eventMissed: 1 });
  });

  it('renders a Markdown table that discloses every take left out and why', () => {
    const md = toMarkdown(rows(), 'footage/2026-10-30');
    expect(md).toContain('2 ran, 1 excluded and 1 failed');
    expect(md).toContain(`\`${run.commitment.short}\``);
    expect(md).toContain('| B01 |');
    expect(md).toContain('did not happen');
    expect(md).toContain('| B02 | excluded | not tracked: no sam-raw.txt in B02/ |');
    expect(md).toContain('| C01 | failed | no ball track |');
    // Every table row has as many cells as its header.
    for (const table of md.split('\n\n').filter((b) => b.startsWith('|'))) {
      const [head, ...body] = table.split('\n');
      const cells = (l: string) => l.replace(/\\\|/g, '').split('|').length;
      for (const line of body) expect(cells(line)).toBe(cells(head!));
    }
  });
});
