import { DEFAULT_WINDOW_END_SEC } from '../../src/fit/recover';
import type { TakeRun } from '../../src/predict/takeRun';

/**
 * One row per take found, whatever happened to it (spec §9: every take's
 * error, no cherry-picking). A take that could not run is listed with why.
 */
export type ResultRow =
  | { readonly status: 'ok'; readonly take: string; readonly set: string; readonly note: string; readonly fps: number; readonly run: TakeRun }
  | { readonly status: 'excluded' | 'failed'; readonly take: string; readonly set: string; readonly note: string };

/** The filming guide names takes A01…D05: the letter is the set (A baseline, B steeper, C block removed, D both). */
export function setOf(take: string): string {
  const m = /^([A-Za-z])\d+/.exec(take);
  return m?.[1]?.toUpperCase() ?? '-';
}

export const num = (v: number | null | undefined, digits: number) => (v === null || v === undefined || !Number.isFinite(v) ? '' : v.toFixed(digits));
const yesNo = (v: boolean | null) => (v === null ? '' : v ? 'yes' : 'no');

type Column = readonly [header: string, cell: (row: ResultRow) => string];
const ok = (cell: (run: TakeRun, row: Extract<ResultRow, { status: 'ok' }>) => string) => (row: ResultRow) =>
  row.status === 'ok' ? cell(row.run, row) : '';

/** Every column of results.csv, in order. Lengths in cm, mm or px, times in s or ms, as the header says. */
export const COLUMNS: readonly Column[] = [
  ['take', (r) => r.take],
  ['set', (r) => r.set],
  ['status', (r) => r.status],
  ['note', (r) => r.note],
  ['fps', ok((_, r) => num(r.fps, 1))],
  ['fit_mode', ok((run) => run.fit.loop.mode)],
  ['fit_rms_mm', ok((run) => num(run.fit.best.rmsCm * 10, 2))],
  ['mu_ramp', ok((run) => num(run.fit.best.params.muRamp, 4))],
  ['restitution', ok((run) => num(run.fit.best.params.restitution, 3))],
  ['release_s', ok((run) => num(run.releaseSec, 4))],
  ['release_shift_ms', ok((run) => num(run.fit.best.timeShiftSec * 1000, 2))],
  ['commitment', ok((run) => run.commitment.hash)],
  ['event', ok((run) => run.prediction.band.kind)],
  ['band_runs', ok((run) => `${run.prediction.band.agreeing}/${run.prediction.band.total}`)],
  ['pred_x_cm', ok((run) => num(run.prediction.nominal.event.x, 2))],
  ['band_x_min_cm', ok((run) => num(run.prediction.band.x[0], 2))],
  ['band_x_max_cm', ok((run) => num(run.prediction.band.x[1], 2))],
  ['pred_t_s', ok((run) => num(run.prediction.nominal.event.t, 4))],
  ['band_t_min_s', ok((run) => num(run.prediction.band.t[0], 4))],
  ['band_t_max_s', ok((run) => num(run.prediction.band.t[1], 4))],
  ['real_x_cm', ok((run) => num(run.outcome.event.real?.x, 2))],
  ['real_t_s', ok((run) => num(run.outcome.event.real?.t, 4))],
  ['event_err_cm', ok((run) => num(run.outcome.event.errorCm, 2))],
  ['event_err_px', ok((run) => num(run.outcome.event.errorPx, 1))],
  ['event_err_ms', ok((run) => num(run.outcome.event.errorMs, 1))],
  ['inside_band', ok((run) => yesNo(run.outcome.event.real ? run.outcome.event.insideBand : false))],
  ['horizon_s', ok((run) => num(run.prediction.horizonEndSec, 3))],
  ['end_err_cm', ok((run) => num(run.outcome.end.errorCm, 2))],
  ['end_err_px', ok((run) => num(run.outcome.end.errorPx, 1))],
  ['traj_rms_mm', ok((run) => num(run.outcome.trajectory.rmsMm, 1))],
  ['traj_rms_px', ok((run) => num(run.outcome.trajectory.rmsPx, 1))],
];

export const csvCell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

export function toCsv(rows: readonly ResultRow[]): string {
  const lines = [COLUMNS.map(([h]) => h).join(','), ...rows.map((row) => COLUMNS.map(([, cell]) => csvCell(cell(row))).join(','))];
  return `${lines.join('\n')}\n`;
}

export interface SetSummary {
  readonly set: string;
  readonly found: number;
  readonly ran: number;
  readonly excluded: number;
  readonly failed: number;
  /** Runs whose real event happened inside the ensemble band. */
  readonly insideBand: number;
  /** Runs where the committed event never happened before the horizon. */
  readonly eventMissed: number;
  readonly meanEventErrCm: number | null;
  readonly worstEventErrCm: number | null;
  readonly meanAbsEventErrMs: number | null;
  readonly worstAbsEventErrMs: number | null;
  readonly meanTrajRmsMm: number | null;
  readonly worstTrajRmsMm: number | null;
}

const mean = (vs: readonly number[]) => (vs.length ? vs.reduce((s, v) => s + v, 0) / vs.length : null);
const worst = (vs: readonly number[]) => (vs.length ? Math.max(...vs) : null);

/** Per set, then "all": counts, and the mean and worst of each error over every run (not only the good ones). */
export function summarise(rows: readonly ResultRow[]): SetSummary[] {
  const sets = [...new Set(rows.map((r) => r.set))].sort();
  return [...sets, 'all'].map((set) => {
    const inSet = rows.filter((r) => set === 'all' || r.set === set);
    const runs = inSet.flatMap((r) => (r.status === 'ok' ? [r.run] : []));
    const eventCm = runs.flatMap((r) => (r.outcome.event.errorCm === null ? [] : [r.outcome.event.errorCm]));
    const eventMs = runs.flatMap((r) => (r.outcome.event.errorMs === null ? [] : [Math.abs(r.outcome.event.errorMs)]));
    const traj = runs.flatMap((r) => (r.outcome.trajectory.rmsMm === null ? [] : [r.outcome.trajectory.rmsMm]));
    return {
      set,
      found: inSet.length,
      ran: runs.length,
      excluded: inSet.filter((r) => r.status === 'excluded').length,
      failed: inSet.filter((r) => r.status === 'failed').length,
      insideBand: runs.filter((r) => r.outcome.event.insideBand).length,
      eventMissed: runs.filter((r) => r.outcome.event.real === null).length,
      meanEventErrCm: mean(eventCm),
      worstEventErrCm: worst(eventCm),
      meanAbsEventErrMs: mean(eventMs),
      worstAbsEventErrMs: worst(eventMs),
      meanTrajRmsMm: mean(traj),
      worstTrajRmsMm: worst(traj),
    };
  });
}

const mdCell = (v: string) => v.replace(/\|/g, '\\|').replace(/\n/g, ' ');
export const mdTable = (headers: readonly string[], rows: readonly (readonly string[])[]) =>
  [`| ${headers.map(mdCell).join(' | ')} |`, `|${headers.map(() => ' --- ').join('|')}|`, ...rows.map((r) => `| ${r.map(mdCell).join(' | ')} |`)].join('\n');

/**
 * The rendered table: what was run, a summary per set, every take's errors,
 * and every take left out with why. `source` names where the takes came from.
 */
export function toMarkdown(rows: readonly ResultRow[], source: string): string {
  const summary = summarise(rows);
  const all = summary.at(-1);
  const out: string[] = [];
  out.push('# Physics Twin: prediction errors, every take');
  out.push('');
  out.push(
    `Takes from \`${source}\`. Every take found is listed below: ${all?.ran ?? 0} ran, ${all?.excluded ?? 0} excluded and ${all?.failed ?? 0} failed, ` +
      'with the reason for each one left out. Each run was fitted on the first ' +
      `${DEFAULT_WINDOW_END_SEC.toFixed(1)} s after the release only, and its prediction was hashed and logged (predictions.jsonl) ` +
      'before the track past the freeze was read.',
  );
  out.push('');
  out.push(
    'The event is the first thing the fitted twin says happens after the freeze: the ball coming down onto the table (touchdown), ' +
      'stopping and coming back (turnaround, e.g. off the block), or, if neither happens before the horizon, where it is at the horizon. ' +
      'The band is the spread of that event over 12 runs with parameters sampled within the fit\'s uncertainty. ' +
      'Event error is the distance between predicted and real event (cm, and px on the source video) and real minus predicted time (ms). ' +
      'Trajectory RMS compares the predicted path with every tracked point from the freeze to the horizon.',
  );
  out.push('');
  out.push('## Summary');
  out.push('');
  out.push(
    mdTable(
      ['Set', 'Found', 'Ran', 'Excluded', 'Failed', 'Inside band', 'Event missed', 'Event error cm (mean / worst)', 'Time error ms, absolute (mean / worst)', 'Trajectory RMS mm (mean / worst)'],
      summary.map((s) => [
        s.set,
        String(s.found),
        String(s.ran),
        String(s.excluded),
        String(s.failed),
        `${s.insideBand}/${s.ran}`,
        String(s.eventMissed),
        `${num(s.meanEventErrCm, 2) || '—'} / ${num(s.worstEventErrCm, 2) || '—'}`,
        `${num(s.meanAbsEventErrMs, 1) || '—'} / ${num(s.worstAbsEventErrMs, 1) || '—'}`,
        `${num(s.meanTrajRmsMm, 1) || '—'} / ${num(s.worstTrajRmsMm, 1) || '—'}`,
      ]),
    ),
  );
  out.push('');
  out.push('## Every take');
  out.push('');
  const runs = rows.filter((r): r is Extract<ResultRow, { status: 'ok' }> => r.status === 'ok');
  out.push(
    mdTable(
      ['Take', 'Fit RMS mm', 'μ ramp', 'e', 'Commitment', 'Event', 'Predicted (band)', 'Real', 'Error cm / px / ms', 'Inside band', 'Trajectory RMS mm / px'],
      runs.map(({ take, run }) => {
        const { prediction: p, outcome: o } = run;
        const real = o.event.real;
        return [
          take,
          num(run.fit.best.rmsCm * 10, 2),
          num(run.fit.best.params.muRamp, 4),
          num(run.fit.best.params.restitution, 3),
          `\`${run.commitment.short}\``,
          `${p.band.kind} (${p.band.agreeing}/${p.band.total} runs)`,
          `x ${num(p.nominal.event.x, 1)} cm (${num(p.band.x[0], 1)}–${num(p.band.x[1], 1)}), t ${num(p.nominal.event.t, 3)} s`,
          real ? `x ${num(real.x, 1)} cm, t ${num(real.t, 3)} s` : 'did not happen',
          real ? `${num(o.event.errorCm, 2)} / ${num(o.event.errorPx, 1)} / ${num(o.event.errorMs, 1)}` : '—',
          real ? (o.event.insideBand ? 'yes' : '**no**') : '**no**',
          `${num(o.trajectory.rmsMm, 1) || '—'} / ${num(o.trajectory.rmsPx, 1) || '—'}`,
        ];
      }),
    ),
  );
  const left = rows.filter((r) => r.status !== 'ok');
  out.push('');
  out.push('## Excluded or failed');
  out.push('');
  out.push(left.length ? mdTable(['Take', 'Status', 'Why'], left.map((r) => [r.take, r.status, r.note])) : 'None: every take found ran.');
  const notes = runs.filter((r) => r.note);
  if (notes.length) {
    out.push('');
    out.push('## Notes');
    out.push('');
    for (const r of notes) out.push(`- ${r.take}: ${r.note}`);
  }
  out.push('');
  return out.join('\n');
}
