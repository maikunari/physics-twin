/**
 * Makes a synthetic take for the overlay page, with no footage and no API key:
 * the fixture scene simulated with known parameters, rendered as a 240 fps
 * clip, plus the scene.json and sam-raw.txt a real take would produce.
 *
 *   npx tsx scripts/make-synthetic-clip.ts [--mu 0.08] [--e 0.55] [--seed 1] [--delay 1] [--out smoke-out/synthetic]
 *
 * Writes synthetic.mp4, scene.json, sam-raw.txt and truth.json (the true
 * parameters and release frame) to the output folder. Needs ffmpeg. The
 * picture is flat shapes, not a photo; it exists to check that the overlay
 * lines up with the video and stays in sync.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { gridBoxToPixelBox, gridToPixel, type ImageSize, type Vec2 } from '../src/scene/calibration';
import { FIXTURE_IMAGE_SIZE, FIXTURE_SCENE } from '../src/scene/fixtures';
import { DEFAULT_SIM_PARAMS, type SimParams } from '../src/sim/params';
import { initRapier } from '../src/sim/sceneWorld';
import { makeSyntheticTake } from '../src/synthetic/syntheticTake';
import { SMOKE_OUT_DIR, fail, parseArgs } from './lib/meta';

type Rgb = readonly [number, number, number];
const BACKDROP: Rgb = [24, 26, 32];
const TABLE: Rgb = [58, 52, 46];
const RAMP: Rgb = [176, 140, 96];
const TAPE: Rgb = [250, 204, 21];
const BLOCK: Rgb = [37, 99, 235];
const BALL: Rgb = [249, 115, 22];

/** A minimal RGB24 rasteriser: enough for flat shapes. */
class Frame {
  readonly data: Buffer;
  constructor(readonly size: ImageSize) {
    this.data = Buffer.alloc(size.width * size.height * 3);
  }

  private set(x: number, y: number, [r, g, b]: Rgb) {
    if (x < 0 || y < 0 || x >= this.size.width || y >= this.size.height) return;
    const i = (y * this.size.width + x) * 3;
    this.data[i] = r;
    this.data[i + 1] = g;
    this.data[i + 2] = b;
  }

  fill(colour: Rgb) {
    for (let i = 0; i < this.size.width * this.size.height; i++) this.data.set(colour, i * 3);
  }

  rect(x0: number, y0: number, x1: number, y1: number, colour: Rgb) {
    for (let y = Math.floor(y0); y < Math.ceil(y1); y++) for (let x = Math.floor(x0); x < Math.ceil(x1); x++) this.set(x, y, colour);
  }

  /** Every pixel whose centre is within `half` of the segment a–b. */
  thickLine(a: Vec2, b: Vec2, half: number, colour: Rgb) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    for (let y = Math.floor(Math.min(a.y, b.y) - half); y <= Math.ceil(Math.max(a.y, b.y) + half); y++) {
      for (let x = Math.floor(Math.min(a.x, b.x) - half); x <= Math.ceil(Math.max(a.x, b.x) + half); x++) {
        const px = x + 0.5;
        const py = y + 0.5;
        const s = Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / len2));
        if (Math.hypot(px - (a.x + s * dx), py - (a.y + s * dy)) <= half) this.set(x, y, colour);
      }
    }
  }

  disc(c: Vec2, r: number, colour: Rgb) {
    for (let y = Math.floor(c.y - r); y <= Math.ceil(c.y + r); y++) {
      for (let x = Math.floor(c.x - r); x <= Math.ceil(c.x + r); x++) {
        if (Math.hypot(x + 0.5 - c.x, y + 0.5 - c.y) <= r) this.set(x, y, colour);
      }
    }
  }
}

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
  const seed = numberFlag(flags, 'seed', 1);
  const size = FIXTURE_IMAGE_SIZE;

  await initRapier();
  const take = makeSyntheticTake(FIXTURE_SCENE, size, params, {
    durationSec: 1.5,
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

  // Everything but the ball is the same every frame: draw it once.
  const background = new Frame(size);
  background.fill(BACKDROP);
  const left = gridToPixel(FIXTURE_SCENE.table.left, size);
  const right = gridToPixel(FIXTURE_SCENE.table.right, size);
  background.rect(left.x, Math.min(left.y, right.y), right.x, size.height, TABLE);
  const rampHalf = take.calibration.pixelsPerCm;
  const top = gridToPixel(FIXTURE_SCENE.ramp.top, size);
  const bottom = gridToPixel(FIXTURE_SCENE.ramp.bottom, size);
  // The ramp's running surface is its top edge: draw the slab just under the line.
  background.thickLine({ x: top.x, y: top.y + rampHalf }, { x: bottom.x, y: bottom.y + rampHalf }, rampHalf, RAMP);
  for (const block of FIXTURE_SCENE.blocks) {
    const box = gridBoxToPixelBox(block.box, size);
    background.rect(box.left, box.top, box.right, box.bottom, BLOCK);
  }
  for (const marker of FIXTURE_SCENE.scaleMarkers) {
    const p = gridToPixel(marker, size);
    background.rect(p.x - 3, p.y - 12, p.x + 3, p.y + 12, TAPE);
  }

  const video = path.join(outDir, 'synthetic.mp4');
  const ffmpeg = spawn(
    'ffmpeg',
    ['-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${size.width}x${size.height}`, '-r', String(fps), '-i', '-',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', video],
    { stdio: ['pipe', 'inherit', 'inherit'] },
  );
  const finished = new Promise<void>((resolve, reject) => {
    ffmpeg.on('error', (err) => reject(new Error(`could not run ffmpeg (is it installed?): ${err.message}`)));
    ffmpeg.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited with ${code}`))));
  });

  const frame = new Frame(size);
  for (const p of take.ballPx) {
    background.data.copy(frame.data);
    frame.disc(p, take.ballRadiusPx, BALL);
    if (!ffmpeg.stdin.write(frame.data)) await new Promise((resolve) => ffmpeg.stdin.once('drain', resolve));
  }
  ffmpeg.stdin.end();
  await finished;

  console.log(`synthetic take: μ_ramp ${params.muRamp}, e ${params.restitution}, released at ${(take.releaseFrame / fps).toFixed(3)} s`);
  console.log(`${take.ballPx.length} frames at ${fps} fps → ${path.relative(process.cwd(), outDir)}/`);
  console.log('  synthetic.mp4  scene.json  sam-raw.txt  truth.json');
  console.log('Load the first three on the overlay page (npm run dev).');
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
