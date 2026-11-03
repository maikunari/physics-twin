/**
 * Writes the site's preset scenes to public/presets/ and their manifest to
 * src/presets/manifest.json. A preset is a clip with its cached Muse Spark
 * scene.json and SAM 3.1 sam-raw.txt, so it runs with the API off.
 *
 *   npm run presets                                                     # the three synthetic presets
 *   npm run presets -- --from ~/physics-twin/footage/2026-10-30 --takes A03,B02,C05   # swap in real takes
 *
 * With --from, each take needs its video (<take>.mov or .mp4) and its folder
 * <take>/ with scene.json and sam-raw.txt, as `npm run results -- <folder>
 * --track` leaves them. The take's set letter picks the slot it replaces
 * (A baseline, B steeper, C block removed, D both); slots not named keep
 * what they had. The video is re-encoded to H.264 MP4 (iPhone HEVC does not
 * play in Chrome) at its own frame rate, scaled to --width (default 1280);
 * the overlay is drawn in the source pixels of scene.json, so only the aspect
 * ratio has to match. Needs ffmpeg.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { calibrate, toWorldScene, worldToPixel, type Vec2 } from '../src/scene/calibration';
import { FIXTURE_IMAGE_SIZE, FIXTURE_SCENE } from '../src/scene/fixtures';
import type { GroundedScene } from '../src/scene/schema';
import { initRapier } from '../src/sim/sceneWorld';
import { presetManifestSchema, type Preset } from '../src/presets/schema';
import { makeSyntheticTake } from '../src/synthetic/syntheticTake';
import { SYNTHETIC_MEASUREMENT, syntheticTruth } from '../src/synthetic/syntheticProblem';
import { applyWhatIf } from '../src/whatif/applyEdit';
import { fail, parseArgs } from './lib/meta';
import { renderSyntheticClip } from './lib/renderClip';
import { findTakes, fpsOf } from './lib/takes';

const PUBLIC_DIR = path.resolve('public/presets');
const MANIFEST = path.resolve('src/presets/manifest.json');

const SLOTS: Record<Preset['set'], { id: string; title: string }> = {
  A: { id: 'baseline', title: 'Baseline: ramp and blue block' },
  B: { id: 'steeper', title: 'Steeper ramp' },
  C: { id: 'no-block', title: 'Blue block removed' },
  D: { id: 'steeper-no-block', title: 'Steeper ramp, block removed' },
};

/** The synthetic steeper ramp: the angle day 5's synthetic B takes used. */
const SYNTHETIC_STEEP_DEG = 38;

function writeManifest(presets: readonly Preset[]) {
  const order = ['A', 'B', 'C', 'D'];
  const sorted = [...presets].sort((a, b) => order.indexOf(a.set) - order.indexOf(b.set));
  writeFileSync(MANIFEST, `${JSON.stringify(presetManifestSchema.parse({ presets: sorted }), null, 2)}\n`);
}

function readManifest(): Preset[] {
  if (!existsSync(MANIFEST)) return [];
  return [...presetManifestSchema.parse(JSON.parse(readFileSync(MANIFEST, 'utf8'))).presets];
}

/** A, B and C of the fixture scene, all with the same true parameters: one physical setup, three configurations. */
async function synthetic(): Promise<Preset[]> {
  await initRapier();
  const size = FIXTURE_IMAGE_SIZE;
  const cal = calibrate(FIXTURE_SCENE, size);
  const world = toWorldScene(FIXTURE_SCENE, cal);
  const grid = (p: Vec2) => {
    const px = worldToPixel(cal, p);
    return { x: (px.x * 1000) / size.width, y: (px.y * 1000) / size.height };
  };
  const steep = applyWhatIf(world, { rampAngleDeg: SYNTHETIC_STEEP_DEG, removeBlockIds: [] });
  const scenes: Partial<Record<Preset['set'], GroundedScene>> = {
    A: FIXTURE_SCENE,
    B: { ...FIXTURE_SCENE, ramp: { top: grid(steep.ramp.top), bottom: grid(steep.ramp.bottom) }, ball: { ...FIXTURE_SCENE.ball, center: grid(steep.ball.center) } },
    C: { ...FIXTURE_SCENE, blocks: [] },
  };
  const truth = syntheticTruth(0.08, 0.55);
  const fps = 240;
  const presets: Preset[] = [];
  let seed = 101;
  for (const set of ['A', 'B', 'C'] as const) {
    const scene = scenes[set];
    if (!scene) continue;
    const slot = SLOTS[set];
    const dir = path.join(PUBLIC_DIR, slot.id);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const take = makeSyntheticTake(scene, size, truth, { durationSec: 2.2, releaseDelaySec: 0.5, fps, seed: seed++, ...SYNTHETIC_MEASUREMENT });
    writeFileSync(path.join(dir, 'scene.json'), `${JSON.stringify({ source: 'synthetic', imageSize: size, markerDistanceCm: 50, scene }, null, 2)}\n`);
    writeFileSync(path.join(dir, 'sam-raw.txt'), take.samText);
    await renderSyntheticClip(scene, size, take, fps, path.join(dir, 'clip.mp4'));
    const title = set === 'B' ? `${slot.title} (${SYNTHETIC_STEEP_DEG}°)` : slot.title;
    presets.push({
      id: slot.id,
      set,
      title,
      source: 'synthetic',
      take: `synthetic-${set}`,
      fps,
      clip: `${slot.id}/clip.mp4`,
      scene: `${slot.id}/scene.json`,
      sam: `${slot.id}/sam-raw.txt`,
      truth: { muRamp: truth.muRamp, restitution: truth.restitution },
    });
    console.log(`${slot.id}: synthetic ${set}, true μ ramp ${truth.muRamp}, e ${truth.restitution}`);
  }
  return presets;
}

function recorded(folder: string, names: readonly string[], width: number): Preset[] {
  const root = path.resolve(folder);
  if (!existsSync(root)) fail(`no such folder: ${root}`);
  const takes = new Map(findTakes(root, path.join(root, 'results')).map((t) => [t.take, t]));
  const presets: Preset[] = [];
  for (const name of names) {
    const take = takes.get(name);
    const set = name[0]?.toUpperCase();
    if (set !== 'A' && set !== 'B' && set !== 'C' && set !== 'D') fail(`${name}: a take's name starts with its set, A–D`);
    if (!take?.video) fail(`${name}: no ${name}.mov or .mp4 in ${root}`);
    for (const file of ['scene.json', 'sam-raw.txt'])
      if (!existsSync(path.join(take.dir, file))) fail(`${name}: no ${file} in ${take.dir} (track it first: npm run results -- ${folder} --track)`);
    const slot = SLOTS[set];
    const dir = path.join(PUBLIC_DIR, slot.id);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    for (const file of ['scene.json', 'sam-raw.txt']) writeFileSync(path.join(dir, file), readFileSync(path.join(take.dir, file)));
    const { fps, note } = fpsOf(take.dir, 240);
    if (note) console.warn(`${name}: ${note}`);
    execFileSync(
      'ffmpeg',
      ['-v', 'error', '-y', '-i', take.video, '-an', '-vf', `scale=${width}:-2`, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
        '-pix_fmt', 'yuv420p', '-movflags', '+faststart', path.join(dir, 'clip.mp4')],
      { stdio: 'inherit' },
    );
    presets.push({
      id: slot.id,
      set,
      title: slot.title,
      source: 'recorded',
      take: name,
      fps,
      clip: `${slot.id}/clip.mp4`,
      scene: `${slot.id}/scene.json`,
      sam: `${slot.id}/sam-raw.txt`,
    });
    console.log(`${slot.id}: recorded take ${name} at ${fps} fps`);
  }
  return presets;
}

async function main() {
  const { flags } = parseArgs(process.argv.slice(2));
  const from = flags.get('from');
  let made: Preset[];
  if (from) {
    const names = (flags.get('takes') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    if (!names.length) fail('--from needs --takes, e.g. --takes A03,B02,C05');
    const width = Number(flags.get('width') ?? 1280);
    if (!(width > 0)) fail('--width must be positive');
    made = recorded(from, names, Math.round(width / 2) * 2);
  } else {
    made = await synthetic();
  }
  const replaced = new Set(made.map((p) => p.set));
  writeManifest([...readManifest().filter((p) => !replaced.has(p.set)), ...made]);
  console.log(`wrote ${path.relative(process.cwd(), MANIFEST)} and ${path.relative(process.cwd(), PUBLIC_DIR)}/`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
