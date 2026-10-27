/**
 * Day-1 smoke test: SAM 3.1 video tracking of the ball (and blocks) with box
 * prompts on frame 0 and per-record confidence, parsed with @meta-sam/parser.
 *
 *   MODEL_API_KEY=... npx tsx scripts/smoke-sam.ts path/to/clip.mov
 *
 * Box prompts come from smoke-out/scene.json (written by smoke-spark.ts) by
 * default, or from `--box left,top,right,bottom` (ball, displayed pixels).
 * Writes smoke-out/sam-raw.txt and smoke-out/sam-summary.json and prints a
 * go/no-go verdict for the ball track.
 */
import { createReadStream, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { buildObjectPrompt, parseVideoStream, type PromptBox } from '@meta-sam/parser';
import type { ResponseCreateParamsStreaming } from 'openai/resources/responses/responses';
import { ballPixelBox, gridBoxToPixelBox, type ImageSize } from '../src/scene/calibration';
import { groundedSceneSchema } from '../src/scene/schema';
import { goNoGo, summariseTracks, type PromptedObject } from './lib/samSummary';
import {
  SAM_MODEL,
  SMOKE_OUT_DIR,
  ensureOutDir,
  fail,
  metaClient,
  parseArgs,
  probeMedia,
  requireApiKey,
} from './lib/meta';

const MAX_CLIP_BYTES = 50 * 1024 * 1024;

interface Prompted extends PromptedObject {
  readonly box: PromptBox;
}

function promptsFromScene(file: string, size: ImageSize): Prompted[] {
  const raw = JSON.parse(readFileSync(file, 'utf8')) as { imageSize?: ImageSize; scene?: unknown };
  const scene = groundedSceneSchema.parse(raw.scene);
  if (raw.imageSize && (raw.imageSize.width !== size.width || raw.imageSize.height !== size.height)) {
    fail(
      `${file} was grounded on a ${raw.imageSize.width}x${raw.imageSize.height} frame but the clip is ${size.width}x${size.height}; re-run smoke-spark.ts on this clip`,
    );
  }
  // The ball is object 1; blocks follow in scene order. These are the ids SAM reports back.
  return [
    { id: '1', kind: 'ball', label: 'ball', box: ballPixelBox(scene, size) },
    ...scene.blocks.map((b, i) => ({
      id: String(i + 2),
      kind: 'block' as const,
      label: b.label,
      box: gridBoxToPixelBox(b.box, size),
    })),
  ];
}

function promptFromFlag(value: string): Prompted[] {
  const parts = value.split(',').map(Number);
  const [left, top, right, bottom] = parts;
  if (parts.length !== 4 || left === undefined || top === undefined || right === undefined || bottom === undefined || parts.some((n) => !Number.isInteger(n))) {
    fail('--box needs four integers: left,top,right,bottom (right/bottom exclusive, displayed pixels)');
  }
  return [{ id: '1', kind: 'ball', label: 'ball', box: { left, top, right, bottom } }];
}

async function main() {
  const apiKey = requireApiKey();
  const { positional, flags } = parseArgs(process.argv.slice(2), ['inline']);
  const clip = positional[0];
  if (!clip) fail('usage: npx tsx scripts/smoke-sam.ts <clip.mov> [--scene smoke-out/scene.json | --box l,t,r,b] [--inline]');
  if (!existsSync(clip)) fail(`no such file: ${clip}`);
  const bytes = readFileSync(clip).byteLength;
  if (bytes > MAX_CLIP_BYTES) fail(`clip is ${(bytes / 1e6).toFixed(1)} MB; trim it under 50 MB (and ideally under 3 s) first`);

  const probe = probeMedia(clip);
  const size = { width: probe.width, height: probe.height };
  const fps = probe.fps ?? 240;
  console.log(
    `clip: ${clip} ${size.width}x${size.height} ${probe.codec ?? '?'} ${probe.fps?.toFixed(1) ?? '?'} fps, ` +
      `${probe.frameCount ?? '?'} frames, ${(bytes / 1e6).toFixed(1)} MB`,
  );
  if (probe.codec && !['h264', 'hevc', 'mpeg4'].includes(probe.codec)) {
    console.warn(`warning: SAM accepts H.264, H.265 or MPEG-4 in MP4/MOV; this clip is ${probe.codec}`);
  }

  const boxFlag = flags.get('box');
  const sceneFile = flags.get('scene') ?? path.join(SMOKE_OUT_DIR, 'scene.json');
  let prompted: Prompted[];
  if (boxFlag) prompted = promptFromFlag(boxFlag);
  else if (existsSync(sceneFile)) prompted = promptsFromScene(sceneFile, size);
  else fail(`no box prompts: run smoke-spark.ts on this clip first (writes ${sceneFile}) or pass --box l,t,r,b`);

  const promptText = buildObjectPrompt({
    size,
    objects: prompted.map((o) => ({ id: o.id, prompts: [{ frame: 0, box: o.box }] })),
  });
  console.log(`prompt: ${promptText}`);

  const client = metaClient(apiKey);
  let videoPart: { type: 'input_video'; file_id: string } | { type: 'input_video'; video_url: string };
  if (flags.has('inline')) {
    const mime = path.extname(clip).toLowerCase() === '.mp4' ? 'video/mp4' : 'video/quicktime';
    videoPart = { type: 'input_video', video_url: `data:${mime};base64,${readFileSync(clip).toString('base64')}` };
    console.log('sending the clip inline as a data URL');
  } else {
    const uploaded = await client.files.create({ file: createReadStream(clip), purpose: 'user_data' });
    videoPart = { type: 'input_video', file_id: uploaded.id };
    console.log(`uploaded via Files API: ${uploaded.id}`);
  }

  // `input_video` is a Meta extension, so the OpenAI request types do not know it.
  const request = {
    model: SAM_MODEL,
    stream: true,
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: promptText }, videoPart] }],
    // Metadata values are strings: include_confidence is "true", not a boolean.
    metadata: { include_confidence: 'true', propagation_direction: 'forward', mask_encoding: 'one_bit' },
  } as unknown as ResponseCreateParamsStreaming;

  const started = Date.now();
  const stream = await client.responses.create(request);
  const parsed = parseVideoStream(stream);
  let lastLog = 0;
  for await (const snapshot of parsed) {
    if (Date.now() - lastLog > 1000) {
      lastLog = Date.now();
      process.stdout.write(`\r  ${snapshot.records.length} records so far…`);
    }
  }
  const result = await parsed.finalResult;
  const elapsedMs = Date.now() - started;
  process.stdout.write('\n');

  const out = ensureOutDir();
  writeFileSync(path.join(out, 'sam-raw.txt'), result.rawOutput);
  console.log(`stream ${result.outcome.status} in ${(elapsedMs / 1000).toFixed(1)} s; raw output: smoke-out/sam-raw.txt`);
  const errors = result.diagnostics.filter((d) => d.severity === 'error');
  if (errors.length) console.warn(`parser reported ${errors.length} error diagnostics, first: ${errors[0]?.message}`);

  const summaries = summariseTracks(result.records, prompted);
  const ball = summaries.find((s) => s.kind === 'ball');
  const ballBox = prompted[0]?.box;
  const verdict = goNoGo(ball, fps, ballBox ? ballBox.right - ballBox.left : 0);
  writeFileSync(
    path.join(out, 'sam-summary.json'),
    JSON.stringify({ clip, probe, prompt: promptText, elapsedMs, outcome: result.outcome, verdict, objects: summaries }, null, 2),
  );

  console.log('\nobject        frames  first..last  run  conf(mean/min)  max step');
  for (const s of summaries) {
    const conf = s.meanConfidence === null ? 'n/a' : `${s.meanConfidence.toFixed(2)}/${s.minConfidence?.toFixed(2)}`;
    console.log(
      `${`${s.id} ${s.label}`.padEnd(13)} ${String(s.framesWithBox).padStart(6)}  ${`${s.firstFrame ?? '-'}..${s.lastFrame ?? '-'}`.padStart(11)}  ${String(s.longestRun).padStart(3)}  ${conf.padStart(14)}  ${s.maxStepPx.toFixed(0).padStart(5)} px`,
    );
  }
  if (ball?.meanConfidence === null) console.warn('note: no confidence values came back (include_confidence not honoured?)');
  console.log(`\n${verdict.go ? 'GO' : 'NO-GO'}: ball track ${verdict.go ? 'looks usable' : 'needs work'}`);
  for (const reason of verdict.reasons) console.log(`  - ${reason}`);
  console.log('summary: smoke-out/sam-summary.json');
  if (!verdict.go) process.exitCode = 1;
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
