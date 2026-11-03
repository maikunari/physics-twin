import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const VIDEO = /\.(mov|mp4|m4v)$/i;

export interface TakeFiles {
  readonly take: string;
  readonly video: string | null;
  readonly dir: string;
}

/** Every take in the folder: each video file and each folder with a take's tracks, by name. */
export function findTakes(root: string, outDir: string): TakeFiles[] {
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

/** The take's frame rate: what ffprobe read when it was tracked, the synthetic take's own, or the default. */
export function fpsOf(dir: string, fallback: number): { fps: number; note: string } {
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
