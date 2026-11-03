import { z } from 'zod';

/** A file of a preset, relative to the site's `/presets/` folder; no climbing out of it. */
const presetPath = z.string().regex(/^[a-z0-9-]+\/[a-z0-9._-]+$/i, 'a preset file is <preset>/<file>');

const presetSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9-]+$/),
  /** The filming guide's set: A baseline, B steeper, C block removed, D both. */
  set: z.enum(['A', 'B', 'C', 'D']),
  title: z.string().min(1),
  /**
   * `recorded`: a filmed take with its cached SAM 3.1 tracks and Muse Spark
   * scene. `synthetic`: drawn from the simulation with known parameters,
   * never filmed; the page and the README say so.
   */
  source: z.enum(['recorded', 'synthetic']),
  /** The take's name: the commitment is logged under it. */
  take: z.string().min(1),
  fps: z.number().positive(),
  clip: presetPath,
  scene: presetPath,
  sam: presetPath,
  /** The parameters a synthetic preset was made from; shown so the fit can be checked against them. */
  truth: z.strictObject({ muRamp: z.number(), restitution: z.number() }).optional(),
});

export const presetManifestSchema = z.strictObject({
  presets: z.array(presetSchema).min(1),
});

export type Preset = z.infer<typeof presetSchema>;
