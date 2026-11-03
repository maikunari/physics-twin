import type { WorldScene } from '../../src/scene/calibration';
import type { WhatIfEdit } from '../../src/scene/whatIfEdit';
import type { CounterfactualTake, WhatIfComparison } from '../../src/whatif/compare';
import { csvCell, mdTable, num } from './resultsTable';

/** How the what-if for a counterfactual set is chosen. */
export interface EditChoice {
  /** The steeper ramp: a fixed angle, or each counterfactual take's own ramp as Muse Spark read it on its frame 0. */
  readonly angleDeg: number | 'from-take';
  /** Blocks the C and D sets took away: these ids, or every block of the baseline scene. */
  readonly removeIds: readonly string[] | 'all';
}

/**
 * The what-if a counterfactual set stands for (filming guide §4): B steeper,
 * C block removed, D both. Only the setup comes from the counterfactual
 * take (its ramp angle, with `from-take`), never its motion. Null for a set
 * that is not a counterfactual (A, or an unknown letter).
 */
export function editFor(set: string, baseline: WorldScene, take: CounterfactualTake, choice: EditChoice): WhatIfEdit | null {
  const angle = choice.angleDeg === 'from-take' ? Math.round(take.rampAngleDeg * 10) / 10 : choice.angleDeg;
  const remove = choice.removeIds === 'all' ? baseline.blocks.map((b) => b.id) : choice.removeIds.filter((id) => baseline.blocks.some((b) => b.id === id));
  if (set === 'B') return { rampAngleDeg: angle, removeBlockIds: [] };
  if (set === 'C') return remove.length ? { rampAngleDeg: null, removeBlockIds: [...remove] } : null;
  if (set === 'D') return { rampAngleDeg: angle, removeBlockIds: [...remove] };
  return null;
}

/** One counterfactual take scored against the what-if from one baseline take's fit. */
export type WhatIfRow =
  | {
      readonly status: 'ok';
      readonly take: string;
      readonly set: string;
      readonly baseline: string;
      readonly edit: string;
      readonly comparison: WhatIfComparison;
    }
  | { readonly status: 'excluded' | 'failed'; readonly take: string; readonly set: string; readonly baseline: string; readonly note: string };

type Ok = Extract<WhatIfRow, { status: 'ok' }>;
const ok = (cell: (r: Ok) => string) => (row: WhatIfRow) => (row.status === 'ok' ? cell(row) : '');

/** Every column of whatif.csv, one row per (counterfactual take, baseline) pair. */
export const WHATIF_COLUMNS: readonly (readonly [string, (row: WhatIfRow) => string])[] = [
  ['take', (r) => r.take],
  ['set', (r) => r.set],
  ['baseline', (r) => r.baseline],
  ['status', (r) => r.status],
  ['note', (r) => (r.status === 'ok' ? '' : r.note)],
  ['edit', ok((r) => r.edit)],
  ['ramp_asked_deg', ok((r) => num(r.comparison.rampAngleDeg.asked, 1))],
  ['ramp_real_deg', ok((r) => num(r.comparison.rampAngleDeg.real, 1))],
  ['camera_shift_px', ok((r) => num(r.comparison.cameraShiftPx, 1))],
  ['landing_pred_x_cm', ok((r) => num(r.comparison.landing.predicted?.x, 2))],
  ['landing_real_x_cm', ok((r) => num(r.comparison.landing.real?.x, 2))],
  ['landing_err_cm', ok((r) => num(r.comparison.landing.errorCm, 2))],
  ['landing_err_px', ok((r) => num(r.comparison.landing.errorPx, 1))],
  ['landing_err_ms', ok((r) => num(r.comparison.landing.errorMs, 1))],
  ['turnaround_pred_x_cm', ok((r) => num(r.comparison.turnaround.predicted?.x, 2))],
  ['turnaround_real_x_cm', ok((r) => num(r.comparison.turnaround.real?.x, 2))],
  ['turnaround_err_cm', ok((r) => num(r.comparison.turnaround.errorCm, 2))],
  ['end_t_s', ok((r) => num(r.comparison.end.t, 3))],
  ['end_err_cm', ok((r) => num(r.comparison.end.errorCm, 2))],
  ['end_err_px', ok((r) => num(r.comparison.end.errorPx, 1))],
  ['traj_rms_mm', ok((r) => num(r.comparison.trajectory.rmsMm, 1))],
  ['traj_rms_px', ok((r) => num(r.comparison.trajectory.rmsPx, 1))],
  ['traj_points', ok((r) => String(r.comparison.trajectory.points))],
];

export function whatIfCsv(rows: readonly WhatIfRow[]): string {
  const lines = [WHATIF_COLUMNS.map(([h]) => h).join(','), ...rows.map((row) => WHATIF_COLUMNS.map(([, cell]) => csvCell(cell(row))).join(','))];
  return `${lines.join('\n')}\n`;
}

const mean = (vs: readonly number[]) => (vs.length ? vs.reduce((s, v) => s + v, 0) / vs.length : null);
const worst = (vs: readonly number[]) => (vs.length ? Math.max(...vs) : null);
const pick = (rows: readonly Ok[], f: (c: WhatIfComparison) => number | null) => rows.flatMap((r) => {
  const v = f(r.comparison);
  return v === null ? [] : [v];
});
const meanWorst = (vs: readonly number[], digits: number) => `${num(mean(vs), digits) || '—'} / ${num(worst(vs), digits) || '—'}`;

/** Summary per set and per counterfactual take (mean and worst over every baseline), then every pair left out with why. */
export function whatIfMarkdown(rows: readonly WhatIfRow[], source: string, choice: EditChoice): string {
  const okRows = rows.filter((r): r is Ok => r.status === 'ok');
  const sets = [...new Set(rows.map((r) => r.set))].sort();
  const takes = [...new Set(rows.map((r) => r.take))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const out: string[] = [];
  out.push('# Physics Twin: what-if against the real counterfactual takes');
  out.push('');
  out.push(
    `Takes from \`${source}\`. Each baseline take (set A) was fitted on its first second, Nelder–Mead alone; the scene was then edited ` +
      `(B: ramp ${choice.angleDeg === 'from-take' ? "at each B take's own grounded angle" : `at ${choice.angleDeg}°`}; C: ` +
      `${choice.removeIds === 'all' ? 'every block removed' : `${choice.removeIds.join(', ')} removed`}; D: both) and re-run with the fitted ` +
      'parameters unchanged. Every counterfactual take is compared with the what-if from every baseline, each from its own detected release, ' +
      "in the baseline's world frame (the camera did not move). Only the setup of a counterfactual take is read before the comparison, never its motion.",
  );
  out.push('');
  out.push('Landing is the first touchdown on the table off the ramp; trajectory RMS is over every tracked point both cover.');
  out.push('');
  out.push('## Summary per set');
  out.push('');
  out.push(
    mdTable(
      ['Set', 'Pairs', 'Left out', 'Landing error cm (mean / worst)', 'Landing time error ms, absolute (mean / worst)', 'Trajectory RMS mm (mean / worst)'],
      sets.map((set) => {
        const inSet = okRows.filter((r) => r.set === set);
        return [
          set,
          String(inSet.length),
          String(rows.filter((r) => r.set === set && r.status !== 'ok').length),
          meanWorst(pick(inSet, (c) => c.landing.errorCm), 2),
          meanWorst(pick(inSet, (c) => (c.landing.errorMs === null ? null : Math.abs(c.landing.errorMs))), 1),
          meanWorst(pick(inSet, (c) => c.trajectory.rmsMm), 1),
        ];
      }),
    ),
  );
  out.push('');
  out.push('## Every counterfactual take');
  out.push('');
  out.push(
    mdTable(
      ['Take', 'What-if', 'Ramp asked / real °', 'Baselines', 'Landing error cm (mean / worst)', 'Trajectory RMS mm (mean / worst)', 'Camera shift px'],
      takes.flatMap((take) => {
        const mine = okRows.filter((r) => r.take === take);
        const first = mine[0];
        if (!first) return [];
        return [
          [
            take,
            first.edit,
            `${num(first.comparison.rampAngleDeg.asked, 1)} / ${num(first.comparison.rampAngleDeg.real, 1)}`,
            String(mine.length),
            meanWorst(pick(mine, (c) => c.landing.errorCm), 2),
            meanWorst(pick(mine, (c) => c.trajectory.rmsMm), 1),
            num(worst(mine.map((r) => r.comparison.cameraShiftPx)), 1),
          ],
        ];
      }),
    ),
  );
  const left = rows.filter((r): r is Exclude<WhatIfRow, Ok> => r.status !== 'ok');
  out.push('');
  out.push('## Excluded or failed');
  out.push('');
  out.push(left.length ? mdTable(['Take', 'Baseline', 'Status', 'Why'], left.map((r) => [r.take, r.baseline, r.status, r.note])) : 'None.');
  out.push('');
  return out.join('\n');
}
