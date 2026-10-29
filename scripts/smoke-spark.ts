/**
 * Day-1 smoke test: Muse Spark perception grounding of frame 0 into the
 * scene JSON, validated by the zod schema.
 *
 *   MODEL_API_KEY=... npx tsx scripts/smoke-spark.ts path/to/clip.mov
 *   MODEL_API_KEY=... npx tsx scripts/smoke-spark.ts path/to/frame0.jpg
 *
 * Writes smoke-out/frame0.jpg, smoke-out/scene.json (which smoke-sam.ts reads
 * for its box prompts), smoke-out/spark-raw.txt and an overlay JPEG to eyeball.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ResponseCreateParamsNonStreaming } from 'openai/resources/responses/responses';
import {
  ballPixelBox,
  calibrate,
  gridBoxToPixelBox,
  gridToPixel,
  rollRadians,
  toWorldScene,
  type PixelBox,
} from '../src/scene/calibration';
import { GROUNDING_PROMPT, groundingTextFormat } from '../src/scene/groundingPrompt';
import { groundedSceneSchema, hasUsableScale, type GroundedScene } from '../src/scene/schema';
import {
  SPARK_MODEL,
  ensureOutDir,
  extractFirstFrame,
  fail,
  metaClient,
  parseArgs,
  probeMedia,
  requireApiKey,
} from './lib/meta';

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png']);

function drawOverlay(frame: string, out: string, scene: GroundedScene, size: { width: number; height: number }) {
  const boxes: [PixelBox, string][] = [[ballPixelBox(scene, size), 'orange']];
  for (const block of scene.blocks) boxes.push([gridBoxToPixelBox(block.box, size), 'blue']);
  const dot = (p: { x: number; y: number }, color: string): [PixelBox, string] => {
    const c = gridToPixel(p, size);
    return [{ left: Math.round(c.x) - 6, top: Math.round(c.y) - 6, right: Math.round(c.x) + 6, bottom: Math.round(c.y) + 6 }, color];
  };
  boxes.push(dot(scene.ramp.top, 'red'), dot(scene.ramp.bottom, 'red'));
  boxes.push(dot(scene.table.left, 'lime'), dot(scene.table.right, 'lime'));
  for (const m of scene.scaleMarkers) boxes.push(dot(m, 'magenta'));
  const filter = boxes
    .map(([b, color]) => `drawbox=x=${b.left}:y=${b.top}:w=${b.right - b.left}:h=${b.bottom - b.top}:color=${color}:t=3`)
    .join(',');
  try {
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', frame, '-vf', filter, out]);
  } catch {
    console.warn('warning: could not draw the overlay image (ffmpeg drawbox failed); the scene JSON is still valid');
  }
}

async function main() {
  const apiKey = requireApiKey();
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const input = positional[0];
  if (!input) fail('usage: npx tsx scripts/smoke-spark.ts <clip.mov|frame0.jpg> [--marker-cm 50]');
  if (!existsSync(input)) fail(`no such file: ${input}`);
  const markerCm = Number(flags.get('marker-cm') ?? 50);
  if (!(markerCm > 0)) fail('--marker-cm must be a positive number');

  const out = ensureOutDir();
  let frame = input;
  if (!IMAGE_EXT.has(path.extname(input).toLowerCase())) {
    frame = path.join(out, 'frame0.jpg');
    extractFirstFrame(input, frame);
  }
  const size = probeMedia(frame);
  const mime = path.extname(frame).toLowerCase() === '.png' ? 'image/png' : 'image/jpeg';
  const dataUrl = `data:${mime};base64,${readFileSync(frame).toString('base64')}`;
  console.log(`frame 0: ${frame} (${size.width}x${size.height}), asking ${SPARK_MODEL} for the scene…`);

  // `input_image` without `detail`, as in Meta's image-understanding docs; the OpenAI types want `detail`.
  const request = {
    model: SPARK_MODEL,
    input: [
      {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: GROUNDING_PROMPT },
          { type: 'input_image', image_url: dataUrl },
        ],
      },
    ],
    text: { format: groundingTextFormat() },
  } as unknown as ResponseCreateParamsNonStreaming;

  const client = metaClient(apiKey);
  const started = Date.now();
  const response = await client.responses.create(request);
  const elapsedMs = Date.now() - started;
  const text = response.output_text;
  writeFileSync(path.join(out, 'spark-raw.txt'), text);
  console.log(`reply in ${elapsedMs} ms, ${text.length} chars (raw: smoke-out/spark-raw.txt)`);
  if (response.usage) console.log(`usage: ${JSON.stringify(response.usage)}`);

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    fail('reply is not JSON; see smoke-out/spark-raw.txt');
  }
  const parsed = groundedSceneSchema.safeParse(json);
  if (!parsed.success) {
    console.error(parsed.error.issues);
    fail('reply does not match the scene schema; see smoke-out/spark-raw.txt');
  }
  const scene = parsed.data;
  const imageSize = { width: size.width, height: size.height };
  writeFileSync(path.join(out, 'scene.json'), JSON.stringify({ source: input, imageSize, markerDistanceCm: markerCm, scene }, null, 2));

  const overlay = path.join(out, 'scene-overlay.jpg');
  drawOverlay(frame, overlay, scene, imageSize);

  console.log('\nscene JSON valid ✓  (smoke-out/scene.json)');
  console.log(`blocks: ${scene.blocks.map((b) => `${b.id} (${b.label})`).join(', ') || 'none'}`);
  console.log(`ball box for SAM (px): ${JSON.stringify(ballPixelBox(scene, imageSize))}`);
  if (!hasUsableScale(scene)) {
    console.log('scale: NOT FOUND (markers missing or too close) ✗');
    process.exitCode = 1;
  } else {
    const cal = calibrate(scene, imageSize, markerCm);
    const world = toWorldScene(scene, cal);
    console.log(`scale: ${cal.pixelsPerCm.toFixed(2)} px/cm from markers ${markerCm} cm apart ✓`);
    console.log(`camera roll from the table line: ${((rollRadians(cal) * 180) / Math.PI).toFixed(2)}°`);
    const rise = world.ramp.top.y - world.ramp.bottom.y;
    const run = world.ramp.bottom.x - world.ramp.top.x;
    console.log(`ramp: ${((Math.atan2(rise, run) * 180) / Math.PI).toFixed(1)}° from horizontal, ball radius ${world.ball.radius.toFixed(1)} cm`);
  }
  console.log(`overlay to check by eye: ${overlay} (orange ball, blue blocks, red ramp ends, green table ends, magenta tape marks)`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
