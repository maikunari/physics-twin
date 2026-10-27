import { z } from 'zod';

/**
 * Scene JSON as Muse Spark perception grounding returns it for frame 0 (spec §4).
 *
 * Coordinates use Muse Spark's normalised 0–1000 image grid: (0, 0) is the
 * top-left corner, (1000, 1000) the bottom-right, x first. The model can
 * overshoot the edge slightly (Meta docs mention values such as 1001), so the
 * schema accepts a small margin and conversion to pixels clamps.
 */
export const GRID_MAX = 1000;
const GRID_MARGIN = 20;

const gridCoord = z
  .number()
  .min(-GRID_MARGIN)
  .max(GRID_MAX + GRID_MARGIN);

export const gridPointSchema = z.strictObject({
  x: gridCoord,
  y: gridCoord,
});

export const gridBoxSchema = z
  .strictObject({
    x_min: gridCoord,
    y_min: gridCoord,
    x_max: gridCoord,
    y_max: gridCoord,
  })
  .refine((b) => b.x_max > b.x_min && b.y_max > b.y_min, {
    message: 'box must have positive width and height',
  });

export const blockSchema = z.strictObject({
  /** Stable id, reused as the SAM object id and by what-if edits ("remove the blue block"). */
  id: z.string().min(1).max(32),
  /** Short human label, e.g. "blue block". */
  label: z.string().min(1).max(64),
  box: gridBoxSchema,
});

export const groundedSceneSchema = z.strictObject({
  /** The ramp's running surface, from the high end to the low end. */
  ramp: z.strictObject({
    top: gridPointSchema,
    bottom: gridPointSchema,
  }),
  /** The table surface line the ball lands on, left end to right end. */
  table: z.strictObject({
    left: gridPointSchema,
    right: gridPointSchema,
  }),
  /** Obstacles resting on the table. Spec §10 caps a scene at five object types. */
  blocks: z.array(blockSchema).max(5),
  ball: z.strictObject({
    center: gridPointSchema,
    /** Radius in grid units measured along the x axis. */
    radius: z.number().positive().max(250),
  }),
  /** The two tape marks placed a known distance apart in the ball's plane. */
  scaleMarkers: z.array(gridPointSchema).length(2),
});

export type GridPoint = z.infer<typeof gridPointSchema>;
export type GridBox = z.infer<typeof gridBoxSchema>;
export type Block = z.infer<typeof blockSchema>;
export type GroundedScene = z.infer<typeof groundedSceneSchema>;

/** Minimum separation between the two scale markers, in grid units, for the scale to count as found. */
export const MIN_SCALE_MARKER_SEPARATION = 20;

/** The scale counts as found when both tape marks are present and far enough apart to measure. */
export function hasUsableScale(scene: GroundedScene): boolean {
  const [a, b] = scene.scaleMarkers;
  if (!a || !b) return false;
  return Math.hypot(b.x - a.x, b.y - a.y) >= MIN_SCALE_MARKER_SEPARATION;
}

/**
 * JSON Schema for the Responses API `text.format` structured-output request.
 * Refinements (box ordering) are not expressible there and are re-checked by
 * `groundedSceneSchema.safeParse` on the reply.
 */
export function groundedSceneJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(groundedSceneSchema, { target: 'draft-7' }) as Record<string, unknown>;
}
