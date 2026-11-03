/**
 * Day-5 what-if table: the twin's what-ifs against the real counterfactual
 * takes (filming guide §4: B steeper, C block removed, D both). Each
 * baseline take (set A) is fitted on its first second; its scene is edited
 * the way the counterfactual set was filmed and re-run with the fitted
 * parameters unchanged; then every counterfactual take is scored against it.
 *
 *   npx tsx scripts/whatif-table.ts ~/physics-twin/footage/2026-10-30 [--angle 32 | --angle from-take] [--remove blue] [--fps 240] [--out <dir>]
 *
 * Takes are found as by results-table.ts (folders with scene.json and
 * sam-raw.txt; track them first with `npm run results -- <folder> --track`).
 * `--angle from-take` (the default) asks for each B or D take's own ramp
 * angle as Muse Spark read it on its frame 0: the setup, never the motion.
 * Writes whatif.csv (every pair) and whatif.md to <folder>/results/ (or --out).
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { runFitSession } from '../src/fit/session';
import { loadOverlayData, predictionInputs, type OverlayData } from '../src/overlay/overlayData';
import { DEFAULT_SIM_PARAMS, type SimParams } from '../src/sim/params';
import { initRapier } from '../src/sim/sceneWorld';
import { describeEdit } from '../src/whatif/applyEdit';
import { compareWhatIf, counterfactualFrom } from '../src/whatif/compare';
import { runWhatIf } from '../src/whatif/run';
import { fail, parseArgs, shown } from './lib/meta';
import { setOf } from './lib/resultsTable';
import { findTakes, fpsOf } from './lib/takes';
import { editFor, whatIfCsv, whatIfMarkdown, type EditChoice, type WhatIfRow } from './lib/whatIfTable';

const COUNTERFACTUAL_SETS = new Set(['B', 'C', 'D']);

interface Loaded {
  readonly take: string;
  readonly data: OverlayData;
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const root = positional[0];
  if (!root) fail('usage: npx tsx scripts/whatif-table.ts <takes folder> [--angle from-take|<deg>] [--remove id,id] [--fps 240] [--out <dir>]');
  if (!existsSync(root) || !statSync(root).isDirectory()) fail(`not a folder: ${root}`);
  const outDir = path.resolve(flags.get('out') ?? path.join(root, 'results'));
  const defaultFps = Number(flags.get('fps') ?? 240);
  if (!(defaultFps > 0)) fail('--fps must be a positive number');
  const angleFlag = flags.get('angle') ?? 'from-take';
  const angle = angleFlag === 'from-take' ? 'from-take' : Number(angleFlag);
  if (angle !== 'from-take' && !(angle > 0 && angle <= 60)) fail('--angle must be from-take or a number of degrees in (0, 60]');
  const choice: EditChoice = { angleDeg: angle, removeIds: flags.get('remove')?.split(',').filter(Boolean) ?? 'all' };

  await initRapier();
  const rows: WhatIfRow[] = [];
  const baselines: (Loaded & { params: SimParams })[] = [];
  const counterfactuals: Loaded[] = [];
  const takes = findTakes(root, outDir);
  if (takes.length === 0) fail(`no takes in ${root}`);

  for (const files of takes) {
    const set = setOf(files.take);
    if (set !== 'A' && !COUNTERFACTUAL_SETS.has(set)) continue;
    const scene = path.join(files.dir, 'scene.json');
    const sam = path.join(files.dir, 'sam-raw.txt');
    if (!existsSync(scene) || !existsSync(sam)) {
      rows.push({ status: 'excluded', take: files.take, set, baseline: '', note: `not tracked: run npm run results -- ${shown(root)} --track first` });
      continue;
    }
    try {
      const data = loadOverlayData({
        sceneJson: readFileSync(scene, 'utf8'),
        samText: readFileSync(sam, 'utf8'),
        fps: fpsOf(files.dir, defaultFps).fps,
        params: DEFAULT_SIM_PARAMS,
      });
      if (set !== 'A') {
        counterfactuals.push({ take: files.take, data });
        continue;
      }
      // The same fit as the page and the results table, Nelder–Mead alone: the window up to the freeze only.
      const { problem } = predictionInputs(data, data.releaseSec);
      const fit = await runFitSession(problem, DEFAULT_SIM_PARAMS);
      baselines.push({ take: files.take, data: { ...data, releaseSec: data.releaseSec + fit.best.timeShiftSec }, params: fit.best.params });
      console.log(`${files.take}: baseline fitted, RMS ${(fit.best.rmsCm * 10).toFixed(2)} mm`);
    } catch (err) {
      rows.push({ status: 'failed', take: files.take, set, baseline: '', note: err instanceof Error ? err.message : String(err) });
    }
  }
  if (baselines.length === 0) console.log('no baseline (set A) take could be fitted: nothing to compare against');
  if (counterfactuals.length === 0) console.log('no counterfactual (B, C or D) takes are tracked in this folder');

  for (const cf of counterfactuals) {
    const set = setOf(cf.take);
    for (const base of baselines) {
      try {
        const real = counterfactualFrom(base.data, cf.take, cf.data);
        const edit = editFor(set, base.data.world, real, choice);
        if (!edit) {
          rows.push({ status: 'excluded', take: cf.take, set, baseline: base.take, note: 'the baseline scene has no block to remove' });
          continue;
        }
        const lastSec = real.points.at(-1)?.t;
        const run = runWhatIf({ world: base.data.world, params: base.params, edit, ...(lastSec ? { untilSec: lastSec } : {}) });
        const comparison = compareWhatIf(run.edited, real, base.data.calibration.pixelsPerCm);
        rows.push({ status: 'ok', take: cf.take, set, baseline: base.take, edit: describeEdit(edit, base.data.world), comparison });
      } catch (err) {
        rows.push({ status: 'failed', take: cf.take, set, baseline: base.take, note: err instanceof Error ? err.message : String(err) });
      }
    }
    const mine = rows.filter((r) => r.take === cf.take && r.status === 'ok');
    console.log(`${cf.take}: compared with ${mine.length} baselines`);
  }

  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, 'whatif.csv'), whatIfCsv(rows));
  writeFileSync(path.join(outDir, 'whatif.md'), whatIfMarkdown(rows, shown(path.resolve(root)), choice));
  console.log(`wrote ${shown(outDir)}/whatif.csv and whatif.md`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
