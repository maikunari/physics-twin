/**
 * Makes a synthetic take for the overlay page, with no footage and no API key:
 * the fixture scene simulated with known parameters, rendered as a 240 fps
 * clip, plus the scene.json and sam-raw.txt a real take would produce.
 *
 *   npx tsx scripts/make-synthetic-clip.ts [--mu 0.08] [--e 0.55] [--seed 1] [--delay 1] [--duration 1.5] [--out smoke-out/synthetic]
 *
 * Writes synthetic.mp4, scene.json, sam-raw.txt and truth.json (the true
 * parameters and release frame) to the output folder. Needs ffmpeg. The
 * picture is flat shapes, not a photo; it exists to check that the overlay
 * lines up with the video and stays in sync.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { FIXTURE_IMAGE_SIZE, FIXTURE_SCENE } from '../src/scene/fixtures';
import { DEFAULT_SIM_PARAMS, type SimParams } from '../src/sim/params';
import { initRapier } from '../src/sim/sceneWorld';
import { makeSyntheticTake } from '../src/synthetic/syntheticTake';
import { SMOKE_OUT_DIR, fail, parseArgs } from './lib/meta';
import { renderSyntheticClip } from './lib/renderClip';

function numberFlag(flags: Map<string, string>, name: string, fallback: number): number {
  const raw = flags.get(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) fail(`--${name} must be a number`);
  return value;
}

async function main() {
  const { flags } = parseArgs(process.argv.slice(2));
  const outDir = path.resolve(flags.get('out') ?? path.join(SMOKE_OUT_DIR, 'synthetic'));
  const fps = 240;
  const params: SimParams = {
    ...DEFAULT_SIM_PARAMS,
    muRamp: numberFlag(flags, 'mu', 0.08),
    muTable: 0.25,
    restitution: numberFlag(flags, 'e', 0.55),
  };
  const releaseDelaySec = numberFlag(flags, 'delay', 1);
  // Seconds simulated after the release; past the 1 s fit window, the rest is what a prediction is checked against.
  const durationSec = numberFlag(flags, 'duration', 1.5);
  if (!(durationSec > 0)) fail('--duration must be positive');
  const seed = numberFlag(flags, 'seed', 1);
  const size = FIXTURE_IMAGE_SIZE;

  await initRapier();
  const take = makeSyntheticTake(FIXTURE_SCENE, size, params, {
    durationSec,
    fps,
    seed,
    releaseDelaySec,
    pixelNoise: 0.7,
    dropRate: 0.05,
    lowConfidenceRate: 0.03,
  });

  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    path.join(outDir, 'scene.json'),
    JSON.stringify({ source: 'synthetic fixture scene', imageSize: size, markerDistanceCm: 50, scene: FIXTURE_SCENE }, null, 2),
  );
  writeFileSync(path.join(outDir, 'sam-raw.txt'), take.samText);
  writeFileSync(
    path.join(outDir, 'truth.json'),
    JSON.stringify({ params, fps, seed, releaseFrame: take.releaseFrame, releaseSec: take.releaseFrame / fps }, null, 2),
  );

  const video = path.join(outDir, 'synthetic.mp4');
  await renderSyntheticClip(FIXTURE_SCENE, size, take, fps, video);

  console.log(`synthetic take: μ_ramp ${params.muRamp}, e ${params.restitution}, released at ${(take.releaseFrame / fps).toFixed(3)} s`);
  console.log(`${take.ballPx.length} frames at ${fps} fps → ${path.relative(process.cwd(), outDir)}/`);
  console.log('  synthetic.mp4  scene.json  sam-raw.txt  truth.json');
  console.log('Load the first three on the overlay page (npm run dev).');
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
