import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { ballTrajectory, loadOverlayData } from '../src/overlay/overlayData';
import { runTake, type TakeRun } from '../src/predict/takeRun';
import { fetchPresetTracks, PRESETS, type Preset } from '../src/presets/presets';
import { presetManifestSchema } from '../src/presets/schema';
import { DEFAULT_SIM_PARAMS } from '../src/sim/params';
import { initRapier } from '../src/sim/sceneWorld';
import { rampAngleDeg } from '../src/whatif/applyEdit';

const PUBLIC = path.resolve('public');

/** `fetch` as the deployed site answers it: the files under public/, nothing else. */
const servePublic = async (url: string) => {
  const file = path.join(PUBLIC, url);
  if (!file.startsWith(PUBLIC + path.sep) || !existsSync(file)) return { ok: false, status: 404, text: async () => '' };
  return { ok: true, status: 200, text: async () => readFileSync(file, 'utf8') };
};

const bySet = (set: Preset['set']) => {
  const preset = PRESETS.find((p) => p.set === set);
  if (!preset) throw new Error(`no preset for set ${set}`);
  return preset;
};

const load = async (preset: Preset) => loadOverlayData({ ...(await fetchPresetTracks(preset, servePublic)), fps: preset.fps, params: DEFAULT_SIM_PARAMS });

beforeAll(async () => {
  await initRapier();
});

describe('preset manifest', () => {
  it('ships the three filming-guide configurations: baseline, steeper, block removed', () => {
    expect(PRESETS.map((p) => p.set)).toEqual(['A', 'B', 'C']);
    expect(new Set(PRESETS.map((p) => p.id)).size).toBe(PRESETS.length);
  });

  it('serves every file a preset names, and a clip small enough to deploy', () => {
    for (const preset of PRESETS) {
      for (const file of [preset.clip, preset.scene, preset.sam]) expect(existsSync(path.join(PUBLIC, 'presets', file)), file).toBe(true);
      expect(statSync(path.join(PUBLIC, 'presets', preset.clip)).size).toBeLessThan(25 * 1024 * 1024);
    }
  });

  it('labels a synthetic preset with the parameters it was made from', () => {
    for (const preset of PRESETS.filter((p) => p.source === 'synthetic')) expect(preset.truth).toBeDefined();
  });

  it('refuses a file path that climbs out of the presets folder', () => {
    const preset = { ...bySet('A'), clip: '../secrets/clip.mp4' };
    expect(presetManifestSchema.safeParse({ presets: [preset] }).success).toBe(false);
    expect(presetManifestSchema.safeParse({ presets: [{ ...bySet('A'), source: 'filmed' }] }).success).toBe(false);
    expect(presetManifestSchema.safeParse({ presets: [] }).success).toBe(false);
  });

  it('says which file failed when a preset cannot be fetched', async () => {
    const missing = { ...bySet('A'), sam: 'baseline/gone.txt' };
    await expect(fetchPresetTracks(missing, servePublic)).rejects.toThrow(/gone\.txt answered 404/);
  });
});

describe('each preset is its configuration', () => {
  it('B is steeper than A, and C has the blocks A has removed', async () => {
    const [a, b, c] = await Promise.all([load(bySet('A')), load(bySet('B')), load(bySet('C'))]);
    expect(rampAngleDeg(b.world)).toBeGreaterThan(rampAngleDeg(a.world) + 5);
    expect(a.world.blocks.length).toBeGreaterThan(0);
    expect(c.world.blocks).toEqual([]);
    for (const data of [a, b, c]) {
      const ball = ballTrajectory(data);
      // AppFlow's guard for a usable take: a ball tracked on at least 30 frames.
      expect(ball?.points.length ?? 0).toBeGreaterThanOrEqual(30);
    }
  });
});

describe('with the API off', () => {
  const runs = new Map<string, TakeRun>();

  beforeAll(async () => {
    // No agent and no network: the fit is Nelder–Mead alone, as on the site with the kill switch on.
    for (const preset of PRESETS) runs.set(preset.id, await runTake({ take: preset.take, ...(await fetchPresetTracks(preset, servePublic)), fps: preset.fps }));
  }, 120_000);

  it('fits, commits and reveals every preset, numeric only', () => {
    for (const preset of PRESETS) {
      const run = runs.get(preset.id)!;
      expect(run.fit.loop.mode).toBe('numericOnly');
      expect(run.outcome.commitmentHash).toBe(run.commitment.hash);
      expect(run.fit.best.rmsCm).toBeLessThan(0.3);
    }
  });

  it('recovers a synthetic preset’s true μ ramp and e', () => {
    for (const preset of PRESETS.filter((p) => p.truth)) {
      const run = runs.get(preset.id)!;
      expect(Math.abs(run.fit.best.params.muRamp - preset.truth!.muRamp), preset.id).toBeLessThan(0.01);
      expect(Math.abs(run.fit.best.params.restitution - preset.truth!.restitution), preset.id).toBeLessThan(0.1);
    }
  });

  it('predicts a synthetic preset’s event to within a few cm, but not always inside the band', () => {
    // The band only spreads μ ramp and e. μ table and rolling damping are held (the first second barely moves
    // them), so a long roll after the block hit can end past the band: the page says so in red, and so does the README.
    for (const preset of PRESETS.filter((p) => p.truth)) {
      const { event } = runs.get(preset.id)!.outcome;
      expect(event.real?.kind, preset.id).toBeDefined();
      expect(event.errorCm, preset.id).toBeLessThan(6);
    }
  });
});
