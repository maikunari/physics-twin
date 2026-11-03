import manifestJson from './manifest.json';
import { presetManifestSchema, type Preset } from './schema';

export type { Preset } from './schema';

/** Where `public/presets/` is served. */
export const PRESETS_BASE = '/presets/';

/** The presets the site ships (`scripts/make-presets.ts` writes the manifest). */
export const PRESETS: readonly Preset[] = presetManifestSchema.parse(manifestJson).presets;

export const presetUrl = (file: string, base = PRESETS_BASE) => `${base}${file}`;

export function presetLabel(preset: Preset): string {
  return preset.source === 'recorded'
    ? `Recorded run, take ${preset.take}: cached SAM 3.1 tracks and Muse Spark scene`
    : 'Synthetic: drawn from the simulation with known parameters, not filmed';
}

type Fetch = (url: string) => Promise<Pick<Response, 'ok' | 'status' | 'text'>>;

/**
 * A preset's cached scene.json and sam-raw.txt: what `/api/scene` and
 * `/api/track` would have answered, so it needs no API.
 */
export async function fetchPresetTracks(preset: Preset, fetchText: Fetch = fetch, base = PRESETS_BASE): Promise<{ sceneJson: string; samText: string }> {
  const get = async (file: string) => {
    const reply = await fetchText(presetUrl(file, base));
    if (!reply.ok) throw new Error(`could not load the ${preset.title} preset: ${file} answered ${reply.status}`);
    return reply.text();
  };
  const [sceneJson, samText] = await Promise.all([get(preset.scene), get(preset.sam)]);
  return { sceneJson, samText };
}
