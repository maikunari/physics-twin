import { describe, expect, it } from 'vitest';
import { calibrate, toWorldScene } from '../../src/scene/calibration';
import { FIXTURE_IMAGE_SIZE, FIXTURE_SCENE } from '../../src/scene/fixtures';
import type { CounterfactualTake, WhatIfComparison } from '../../src/whatif/compare';
import { editFor, whatIfCsv, whatIfMarkdown, WHATIF_COLUMNS, type WhatIfRow } from './whatIfTable';

const world = toWorldScene(FIXTURE_SCENE, calibrate(FIXTURE_SCENE, FIXTURE_IMAGE_SIZE));
const take = (rampAngleDeg: number): CounterfactualTake => ({ take: 'B01', points: [], fps: 240, rampAngleDeg, blockIds: [], cameraShiftPx: 0 });

const comparison = (landingErrorCm: number, rmsMm: number): WhatIfComparison => ({
  take: 'B01',
  rampAngleDeg: { asked: 32, real: 31.6 },
  landing: { predicted: { kind: 'touchdown', t: 0.5, x: 50, y: 1 }, real: { kind: 'touchdown', t: 0.51, x: 50 + landingErrorCm, y: 1 }, errorCm: landingErrorCm, errorPx: landingErrorCm * 11.5, errorMs: 10 },
  turnaround: { predicted: null, real: null, errorCm: null, errorPx: null, errorMs: null },
  end: { t: 2, predicted: null, real: null, errorCm: null, errorPx: null },
  trajectory: { points: 400, rmsMm, rmsPx: rmsMm * 1.15 },
  cameraShiftPx: 1.5,
  cameraMoved: false,
});

describe('editFor', () => {
  it('stands each counterfactual set for its edit', () => {
    const choice = { angleDeg: 32, removeIds: 'all' } as const;
    expect(editFor('B', world, take(31.6), choice)).toEqual({ rampAngleDeg: 32, removeBlockIds: [] });
    expect(editFor('C', world, take(20), choice)).toEqual({ rampAngleDeg: null, removeBlockIds: ['blue'] });
    expect(editFor('D', world, take(31.6), choice)).toEqual({ rampAngleDeg: 32, removeBlockIds: ['blue'] });
    expect(editFor('A', world, take(20), choice)).toBeNull();
  });

  it('takes the setup angle from the take when asked, and only known blocks', () => {
    expect(editFor('B', world, take(31.64), { angleDeg: 'from-take', removeIds: 'all' })).toEqual({ rampAngleDeg: 31.6, removeBlockIds: [] });
    expect(editFor('C', world, take(20), { angleDeg: 32, removeIds: ['red'] })).toBeNull();
  });
});

describe('the what-if table', () => {
  const rows: WhatIfRow[] = [
    { status: 'ok', take: 'B01', set: 'B', baseline: 'A01', edit: 'ramp 20.0° → 32.0°', comparison: comparison(1, 10) },
    { status: 'ok', take: 'B01', set: 'B', baseline: 'A02', edit: 'ramp 20.0° → 32.0°', comparison: comparison(3, 20) },
    { status: 'failed', take: 'C01', set: 'C', baseline: 'A01', note: 'no ball track' },
  ];

  it('writes every pair to the CSV, failures included', () => {
    const lines = whatIfCsv(rows).trim().split('\n');
    expect(lines).toHaveLength(4);
    expect(lines[0]?.split(',')).toEqual(WHATIF_COLUMNS.map(([h]) => h));
    expect(lines[3]).toContain('failed,no ball track');
  });

  it('summarises mean and worst over every baseline, and lists what was left out', () => {
    const md = whatIfMarkdown(rows, 'footage', { angleDeg: 32, removeIds: 'all' });
    expect(md).toContain('| B | 2 | 0 | 2.00 / 3.00 | 10.0 / 10.0 | 15.0 / 20.0 |');
    expect(md).toContain('| C | 0 | 1 | — / — | — / — | — / — |');
    expect(md).toContain('| B01 | ramp 20.0° → 32.0° | 32.0 / 31.6 | 2 | 2.00 / 3.00 | 15.0 / 20.0 | 1.5 |');
    expect(md).toContain('| C01 | A01 | failed | no ball track |');
  });
});
