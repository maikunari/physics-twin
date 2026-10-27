import { groundedSceneJsonSchema } from './schema';

/**
 * Instruction for Muse Spark perception grounding on frame 0. Coordinates
 * follow the Meta docs' grounding convention: a 0–1000 grid over the image
 * the model received, (0, 0) top-left, x first.
 */
export const GROUNDING_PROMPT = `This is the first frame of a side-on video of a tabletop physics setup: a ball resting at the top of a ramp, a table surface, possibly some blocks on the table, and two tape marks placed a known distance apart.

Report positions on a 0-1000 grid normalised to this image: (0, 0) is the top-left corner, (1000, 1000) the bottom-right, x first (left to right), then y (top to bottom).

Return:
- ramp.top and ramp.bottom: the two ends of the ramp's running surface, where the ball rolls; the high end is top.
- table.left and table.right: the two ends of the visible table surface line the ball will land on.
- blocks: every block resting on the table, with a short lowercase id (its colour if it has one, e.g. "blue"), a short label and its bounding box. Use an empty list if there are none. At most 5.
- ball.center and ball.radius: the ball's centre, and its radius in grid units measured along x.
- scaleMarkers: the centres of the two tape marks, left one first.

Only report what is visible. Do not invent objects.`;

/** The `text.format` block for a strict structured-output Responses request. */
export function groundingTextFormat() {
  const schema = { ...groundedSceneJsonSchema() };
  delete schema.$schema;
  return { type: 'json_schema' as const, name: 'grounded_scene', schema, strict: true };
}
