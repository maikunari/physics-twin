import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import OpenAI from 'openai';

/** Meta Model API: OpenAI-SDK compatible Responses API (dev.meta.ai/docs/quickstart). */
export const META_BASE_URL = 'https://api.meta.ai/v1';
/** Overrides the base URL, only for pointing the scripts at a local mock server. */
const BASE_URL_OVERRIDE = process.env.META_API_BASE_URL?.trim();
export const SAM_MODEL = 'sam-3.1';
export const SPARK_MODEL = 'muse-spark-1.3';

/** Where smoke runs write their raw output and summaries; git-ignored. */
export const SMOKE_OUT_DIR = path.resolve('smoke-out');

/**
 * Returns the key or exits non-zero. The OpenAI SDK does not read
 * MODEL_API_KEY by itself, so every client is built with it explicitly.
 */
export function requireApiKey(): string {
  const key = process.env.MODEL_API_KEY?.trim();
  if (!key) {
    const script = path.relative(process.cwd(), process.argv[1] ?? 'scripts/smoke-sam.ts');
    console.error('MODEL_API_KEY not set.');
    console.error('Run with the key in the environment, e.g.');
    console.error(`  MODEL_API_KEY=... npx tsx ${script} path/to/clip.mov`);
    process.exit(2);
  }
  return key;
}

export function metaClient(apiKey: string): OpenAI {
  return new OpenAI({ apiKey, baseURL: BASE_URL_OVERRIDE || META_BASE_URL });
}

export function ensureOutDir(): string {
  mkdirSync(SMOKE_OUT_DIR, { recursive: true });
  return SMOKE_OUT_DIR;
}

export function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}

export interface VideoProbe {
  /** Displayed size, after the rotation the file specifies (what SAM prompts must use). */
  readonly width: number;
  readonly height: number;
  readonly frameCount: number | null;
  readonly fps: number | null;
  readonly durationSec: number | null;
  readonly codec: string | null;
}

interface FfprobeStream {
  width?: number;
  height?: number;
  codec_name?: string;
  nb_frames?: string;
  avg_frame_rate?: string;
  duration?: string;
  tags?: { rotate?: string };
  side_data_list?: { rotation?: number }[];
}

function parseRate(rate: string | undefined): number | null {
  if (!rate) return null;
  const [n, d] = rate.split('/').map(Number);
  if (!n || !d) return null;
  return n / d;
}

/** Reads size, rotation, frame count and fps with ffprobe (needs ffmpeg installed). */
export function probeMedia(file: string): VideoProbe {
  let raw: string;
  try {
    raw = execFileSync(
      'ffprobe',
      ['-v', 'error', '-select_streams', 'v:0', '-show_streams', '-of', 'json', file],
      { encoding: 'utf8' },
    );
  } catch (err) {
    fail(`ffprobe failed on ${file} (is ffmpeg installed? macOS: brew install ffmpeg): ${String(err)}`);
  }
  const stream = (JSON.parse(raw) as { streams?: FfprobeStream[] }).streams?.[0];
  if (!stream?.width || !stream.height) fail(`no video stream with a size in ${file}`);
  const rotation = Number(stream.side_data_list?.find((s) => s.rotation !== undefined)?.rotation ?? stream.tags?.rotate ?? 0);
  const quarterTurn = Math.abs(rotation) % 180 === 90;
  const frames = stream.nb_frames ? Number(stream.nb_frames) : NaN;
  const duration = stream.duration ? Number(stream.duration) : NaN;
  return {
    width: quarterTurn ? stream.height : stream.width,
    height: quarterTurn ? stream.width : stream.height,
    frameCount: Number.isFinite(frames) ? frames : null,
    fps: parseRate(stream.avg_frame_rate),
    durationSec: Number.isFinite(duration) ? duration : null,
    codec: stream.codec_name ?? null,
  };
}

/** Pulls frame 0 as a JPEG (ffmpeg applies the file's rotation, so it matches the displayed size). */
export function extractFirstFrame(video: string, outFile: string): void {
  try {
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', video, '-frames:v', '1', '-q:v', '2', outFile]);
  } catch (err) {
    fail(`ffmpeg could not extract frame 0 from ${video}: ${String(err)}`);
  }
}

/** Minimal `--flag value` parser; flags named in `booleans` take no value. Positional arguments are returned in order. */
export function parseArgs(
  argv: readonly string[],
  booleans: readonly string[] = [],
): { positional: string[]; flags: Map<string, string> } {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg.startsWith('--') && booleans.includes(arg.slice(2))) {
      flags.set(arg.slice(2), 'true');
    } else if (arg.startsWith('--')) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) fail(`${arg} needs a value`);
      flags.set(arg.slice(2), value);
      i++;
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}
