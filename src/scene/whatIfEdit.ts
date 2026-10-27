import { z } from 'zod';

/** Steepest ramp a what-if may ask for (spec §6: angles over 60° are rejected). */
export const MAX_RAMP_ANGLE_DEG = 60;

/**
 * A counterfactual edit applied to the frozen scene, from a slider or from a
 * Muse Spark text what-if. Day 1 covers the two slider edits; the text editor
 * extends this later.
 */
export const whatIfEditSchema = z
  .strictObject({
    /** New ramp angle from horizontal, or null to keep the fitted one. */
    rampAngleDeg: z.number().gt(0).max(MAX_RAMP_ANGLE_DEG).nullable(),
    /** Ids of blocks to take out of the scene. */
    removeBlockIds: z.array(z.string().min(1)).max(5),
  })
  .refine((e) => e.rampAngleDeg !== null || e.removeBlockIds.length > 0, {
    message: 'edit changes nothing',
  });

export type WhatIfEdit = z.infer<typeof whatIfEditSchema>;
