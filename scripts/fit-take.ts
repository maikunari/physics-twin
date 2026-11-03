/**
 * Day-3 fit from the terminal: the same fit loop the overlay page runs in its
 * worker (FitLoop machine, Nelder–Mead, and the Muse Spark agent when a key
 * is set), on a take's scene.json and sam-raw.txt, reading only the first
 * second after the release.
 *
 *   npx tsx scripts/fit-take.ts smoke-out/scene.json smoke-out/sam-raw.txt [--fps 240] [--no-agent]
 *   MODEL_API_KEY=... npx tsx scripts/fit-take.ts smoke-out/synthetic/scene.json smoke-out/synthetic/sam-raw.txt
 *
 * Prints the log as it goes and writes smoke-out/fit-log.json.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createFitAgent } from '../src/agent/fitAgent';
import { makeFitProblem, muRampRollingThreshold } from '../src/fit/fitter';
import { describeShift, runFitSession } from '../src/fit/session';
import { fitRequestForOverlay, loadOverlayData } from '../src/overlay/overlayData';
import { DEFAULT_SIM_PARAMS } from '../src/sim/params';
import { initRapier } from '../src/sim/sceneWorld';
import { META_BASE_URL, ensureOutDir, fail, parseArgs } from './lib/meta';
import { scriptSparkTransport } from './lib/agentTransport';

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2), ['no-agent']);
  const [sceneFile, samFile] = positional;
  if (!sceneFile || !samFile) fail('usage: npx tsx scripts/fit-take.ts <scene.json> <sam-raw.txt> [--fps 240] [--no-agent]');
  for (const f of [sceneFile, samFile]) if (!existsSync(f)) fail(`no such file: ${f}`);
  const fps = Number(flags.get('fps') ?? 240);
  if (!(fps > 0)) fail('--fps must be a positive number');

  const apiKey = process.env.MODEL_API_KEY?.trim();
  const useAgent = !flags.has('no-agent') && Boolean(apiKey);
  if (!flags.has('no-agent') && !apiKey) console.log('MODEL_API_KEY not set: fitting with Nelder–Mead alone.');
  const transport = scriptSparkTransport({ apiKey, baseUrl: process.env.META_API_BASE_URL?.trim() || META_BASE_URL });

  await initRapier();
  const data = loadOverlayData({
    sceneJson: readFileSync(sceneFile, 'utf8'),
    samText: readFileSync(samFile, 'utf8'),
    fps,
    params: DEFAULT_SIM_PARAMS,
  });
  const request = fitRequestForOverlay(data, useAgent);
  console.log(`release at ${data.releaseSec.toFixed(3)} s; fitting on ${request.points.length} points up to ${request.windowEndSec} s after it`);

  const started = Date.now();
  const result = await runFitSession(makeFitProblem(request.world, request.points), request.initial, {
    ...(useAgent ? { agent: createFitAgent({ transport }) } : {}),
    onLog: (entry) => console.log(`[${entry.kind}] ${entry.text}`),
  });
  const { best, loop } = result;
  const threshold = muRampRollingThreshold(data.world);
  console.log(
    `\n${loop.mode}, ${loop.iterations} iterations, ${loop.reason}, ${result.simulations} simulations in ${Date.now() - started} ms`,
  );
  console.log(
    `μ ramp ${best.params.muRamp >= 0.9 * threshold ? `≥ ${threshold.toFixed(3)} (rolls without slipping)` : best.params.muRamp.toFixed(4)}, e ${best.params.restitution.toFixed(3)}, release ${describeShift(best.timeShiftSec)}, RMS ${(best.rmsCm * 10).toFixed(2)} mm`,
  );
  const out = path.join(ensureOutDir(), 'fit-log.json');
  writeFileSync(out, JSON.stringify({ sceneFile, samFile, fps, releaseSec: data.releaseSec, ...result }, null, 2));
  console.log(`log: ${path.relative(process.cwd(), out)}`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
