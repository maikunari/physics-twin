/**
 * Day-4 results table: runs every take in a folder through the whole
 * pipeline (fit on the first second, freeze, predict and commit, reveal) and
 * writes every take's error, including the ones that could not run and why.
 *
 *   npx tsx scripts/results-table.ts ~/physics-twin/footage/2026-10-30 [--out <dir>] [--fps 240] [--no-agent] [--track]
 *
 * A take is a video `A01.mov` and/or a folder `A01/` holding its tracks:
 * `scene.json` (smoke-spark.ts) and `sam-raw.txt` (smoke-sam.ts), plus
 * `sam-summary.json` for its frame rate. `--track` makes missing tracks first
 * (needs MODEL_API_KEY; trims each clip to its first 3 s, since SAM bills per
 * frame). Without a key, or with --no-agent, the fit is Nelder–Mead alone.
 *
 * Writes to <folder>/results/ (or --out): results.csv, results.md,
 * predictions.jsonl (each commitment, written before that take's reveal) and
 * runs.json (everything, for checking).
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createFitAgent } from '../src/agent/fitAgent';
import { runTake } from '../src/predict/takeRun';
import { initRapier } from '../src/sim/sceneWorld';
import { META_BASE_URL, fail, parseArgs, shown } from './lib/meta';
import { setOf, summarise, toCsv, toMarkdown, type ResultRow } from './lib/resultsTable';
import { scriptSparkTransport } from './lib/sparkProxy';

const VIDEO = /\.(mov|mp4|m4v)$/i;
/** SAM bills per frame: a take is trimmed to this before tracking (1 s wait, 1 s fitted, 1 s predicted). */
const TRACK_SECONDS = 3;

interface TakeFiles {
  readonly take: string;
  readonly video: string | null;
  readonly dir: string;
}

/** Every take in the folder: each video file and each folder with a take's tracks, by name. */
function findTakes(root: string, outDir: string): TakeFiles[] {
  const takes = new Map<string, TakeFiles>();
  for (const name of readdirSync(root)) {
    const full = path.join(root, name);
    if (path.resolve(full) === path.resolve(outDir)) continue;
    if (statSync(full).isDirectory()) {
      if (['scene.json', 'sam-raw.txt'].some((f) => existsSync(path.join(full, f))))
        takes.set(name, { take: name, video: takes.get(name)?.video ?? null, dir: full });
    } else if (VIDEO.test(name)) {
      const take = name.replace(VIDEO, '');
      takes.set(take, { take, video: full, dir: path.join(root, take) });
    }
  }
  return [...takes.values()].sort((a, b) => a.take.localeCompare(b.take, undefined, { numeric: true }));
}

function runScript(script: string, args: readonly string[]): boolean {
  const res = spawnSync('npx', ['tsx', path.join('scripts', script), ...args], { stdio: 'inherit' });
  return res.status === 0;
}

/** Makes scene.json and sam-raw.txt for one take with Muse Spark and SAM 3.1. Returns why it failed, or null. */
function track(files: TakeFiles): string | null {
  if (!files.video) return 'no video to track';
  mkdirSync(files.dir, { recursive: true });
  const clip = path.join(files.dir, `clip${path.extname(files.video)}`);
  const trim = spawnSync('ffmpeg', ['-v', 'error', '-y', '-ss', '0', '-t', String(TRACK_SECONDS), '-i', files.video, '-c', 'copy', clip], {
    stdio: 'inherit',
  });
  if (trim.status !== 0) return `ffmpeg could not trim ${files.video}`;
  if (!runScript('smoke-spark.ts', [clip, '--out', files.dir])) return 'Muse Spark grounding failed (see the log above)';
  // smoke-sam exits non-zero on a NO-GO verdict too; the take still runs if it wrote its tracks.
  runScript('smoke-sam.ts', [clip, '--out', files.dir]);
  return existsSync(path.join(files.dir, 'sam-raw.txt')) ? null : 'SAM 3.1 tracking failed (see the log above)';
}

/** The take's frame rate: what ffprobe read when it was tracked, the synthetic take's own, or the default. */
function fpsOf(dir: string, fallback: number): { fps: number; note: string } {
  const read = (file: string) => {
    try {
      return JSON.parse(readFileSync(path.join(dir, file), 'utf8')) as Record<string, unknown>;
    } catch {
      return null;
    }
  };
  const probed = (read('sam-summary.json')?.probe as { fps?: unknown } | undefined)?.fps;
  if (typeof probed === 'number' && probed > 0) return { fps: probed, note: '' };
  const truth = read('truth.json');
  if (typeof truth?.fps === 'number' && truth.fps > 0) {
    const p = truth.params as { muRamp?: number; restitution?: number } | undefined;
    return { fps: truth.fps, note: `synthetic take (true μ ramp ${p?.muRamp}, e ${p?.restitution})` };
  }
  return { fps: fallback, note: `frame rate not recorded; assumed ${fallback} fps` };
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2), ['no-agent', 'track']);
  const root = positional[0];
  if (!root) fail('usage: npx tsx scripts/results-table.ts <takes folder> [--out <dir>] [--fps 240] [--no-agent] [--track]');
  if (!existsSync(root) || !statSync(root).isDirectory()) fail(`not a folder: ${root}`);
  const outDir = path.resolve(flags.get('out') ?? path.join(root, 'results'));
  const defaultFps = Number(flags.get('fps') ?? 240);
  if (!(defaultFps > 0)) fail('--fps must be a positive number');

  const apiKey = process.env.MODEL_API_KEY?.trim();
  if (flags.has('track') && !apiKey) fail('--track needs MODEL_API_KEY');
  const useAgent = !flags.has('no-agent') && Boolean(apiKey);
  const transport = scriptSparkTransport({ apiKey, baseUrl: process.env.META_API_BASE_URL?.trim() || META_BASE_URL });

  const takes = findTakes(root, outDir);
  if (takes.length === 0) fail(`no takes in ${root} (expected videos like A01.mov or folders like A01/ with scene.json and sam-raw.txt)`);
  console.log(`${takes.length} takes in ${root}; fit: ${useAgent ? 'Muse Spark agent + Nelder–Mead' : 'Nelder–Mead alone'}`);

  mkdirSync(outDir, { recursive: true });
  const commitments = path.join(outDir, 'predictions.jsonl');
  writeFileSync(commitments, '');
  await initRapier();

  const rows: ResultRow[] = [];
  for (const files of takes) {
    const { take } = files;
    const set = setOf(take);
    const scene = path.join(files.dir, 'scene.json');
    const sam = path.join(files.dir, 'sam-raw.txt');
    if ((!existsSync(scene) || !existsSync(sam)) && flags.has('track')) {
      console.log(`\n${take}: tracking`);
      const why = track(files);
      if (why) {
        rows.push({ status: 'failed', take, set, note: why });
        continue;
      }
    }
    if (!existsSync(scene) || !existsSync(sam)) {
      const missing = [scene, sam].filter((f) => !existsSync(f)).map((f) => path.basename(f));
      rows.push({ status: 'excluded', take, set, note: `not tracked: no ${missing.join(' or ')} in ${take}/ (run with --track and MODEL_API_KEY)` });
      console.log(`${take}: excluded, not tracked`);
      continue;
    }
    const { fps, note } = fpsOf(files.dir, defaultFps);
    try {
      const run = await runTake({
        take,
        sceneJson: readFileSync(scene, 'utf8'),
        samText: readFileSync(sam, 'utf8'),
        fps,
        ...(useAgent ? { agent: createFitAgent({ transport }) } : {}),
        // Logged to disk before the reveal reads anything past the freeze.
        onCommit: (c) => appendFileSync(commitments, `${JSON.stringify({ take, hash: c.hash, committedAt: c.committedAt, payload: c.payload })}\n`),
      });
      rows.push({ status: 'ok', take, set, note, fps, run });
      const o = run.outcome.event;
      console.log(
        `${take}: commit ${run.commitment.short}, ${run.prediction.band.kind} ` +
          (o.real
            ? `error ${o.errorCm?.toFixed(2)} cm${o.errorMs === null ? '' : ` / ${o.errorMs.toFixed(1)} ms`}, ${o.insideBand ? 'inside' : 'OUTSIDE'} the band`
            : 'did not happen'),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      rows.push({ status: 'failed', take, set, note: message });
      console.log(`${take}: failed, ${message}`);
    }
  }

  writeFileSync(path.join(outDir, 'results.csv'), toCsv(rows));
  writeFileSync(path.join(outDir, 'results.md'), toMarkdown(rows, shown(path.resolve(root))));
  writeFileSync(
    path.join(outDir, 'runs.json'),
    JSON.stringify(
      // The drawn paths and the per-iteration history follow from the rest; left out to keep the file small.
      rows.map((r) => {
        if (r.status !== 'ok') return r;
        const { prediction, fit } = r.run;
        const unpathed = <T extends { path: unknown }>(run: T) => ({ ...run, path: undefined });
        return {
          ...r,
          run: {
            ...r.run,
            fit: { ...fit, history: undefined },
            prediction: { ...prediction, nominal: unpathed(prediction.nominal), members: prediction.members.map(unpathed) },
          },
        };
      }),
      null,
      1,
    ),
  );
  const all = summarise(rows).at(-1);
  console.log(
    `\n${all?.ran ?? 0} ran, ${all?.excluded ?? 0} excluded, ${all?.failed ?? 0} failed; ${all?.insideBand ?? 0}/${all?.ran ?? 0} inside the band`,
  );
  console.log(`wrote ${shown(outDir)}/results.csv, results.md, predictions.jsonl, runs.json`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
