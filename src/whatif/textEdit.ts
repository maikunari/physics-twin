import { z } from 'zod';
import { SPARK_AGENT_MODEL, outputText, sparkResponseSchema } from '../agent/sparkWire';
import { MAX_RAMP_ANGLE_DEG, whatIfEditSchema, type WhatIfEdit } from '../scene/whatIfEdit';

export const MAX_WHATIF_TEXT = 300;

/**
 * What the page sends `/api/whatif`: the typed what-if and just enough of
 * the frozen scene for Muse Spark to resolve it ("twice as steep", "the blue
 * block"). No image and no track: the edit is about the scene, not the footage.
 */
export const whatIfAskSchema = z.strictObject({
  text: z.string().trim().min(1).max(MAX_WHATIF_TEXT),
  /** The frozen scene's ramp angle, degrees. */
  rampAngleDeg: z.number().gt(0).lt(90),
  blocks: z
    .array(z.strictObject({ id: z.string().min(1).max(32), label: z.string().min(1).max(64) }))
    .max(5),
});
export type WhatIfAsk = z.infer<typeof whatIfAskSchema>;

/**
 * Muse Spark's structured reply. It may say it cannot express a request
 * (adding objects, changing the ball) by leaving both fields empty; the note
 * says why. The edit itself is re-validated by `whatIfEditSchema` and against
 * the scene's block ids, so a reply that breaks a rule (an angle over 60°, a
 * block that is not there) is refused, never clamped.
 */
export const whatIfReplySchema = z.strictObject({
  rampAngleDeg: z.number().nullable(),
  removeBlockIds: z.array(z.string()),
  note: z.string(),
});

export type WhatIfAnswer =
  | { readonly ok: true; readonly edit: WhatIfEdit; readonly note: string }
  | { readonly ok: false; readonly error: string };

/** Checks an edit against the schema and the scene's blocks. The one check both the server and the page's what-if machine run. */
export function validateEdit(raw: unknown, blockIds: readonly string[]): WhatIfAnswer {
  const parsed = whatIfEditSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, error: `edit refused: ${issue?.path.join('.') || 'edit'} ${issue?.message ?? 'is invalid'}` };
  }
  const known = new Set(blockIds);
  const unknown = parsed.data.removeBlockIds.filter((id) => !known.has(id));
  if (unknown.length) return { ok: false, error: `edit refused: no block ${unknown.join(', ')} in the scene` };
  return { ok: true, edit: parsed.data, note: '' };
}

const INSTRUCTIONS = `You turn a "what if" about a tabletop physics scene into a structured edit. The scene is a ball released at the top of a ramp that runs down onto a table, with some blocks on the table.

Only two changes exist:
- rampAngleDeg: the ramp's new angle from the table in degrees (absolute, not a change). "Twice as steep" means twice the current angle; "5 degrees steeper" means current + 5. Use null to keep the current angle.
- removeBlockIds: ids of blocks to take off the table, from the list given. Use an empty list to keep them all.

Never invent block ids. Do not clamp or round an angle the user asked for, even if it is extreme; report it as asked. If the request asks for anything else (adding objects, moving blocks, changing the ball or the friction), leave rampAngleDeg null and removeBlockIds empty for that part and say so in note. Keep note to one short sentence.`;

/** The Responses API request for one text what-if (structured output, no tools). */
export function whatIfSparkRequest(ask: WhatIfAsk) {
  const blocks = ask.blocks.length ? ask.blocks.map((b) => `${b.id} (${b.label})`).join(', ') : 'none';
  const schema = { ...(z.toJSONSchema(whatIfReplySchema, { target: 'draft-7' }) as Record<string, unknown>) };
  delete schema.$schema;
  return {
    model: SPARK_AGENT_MODEL,
    instructions: INSTRUCTIONS,
    input: [
      {
        type: 'message' as const,
        role: 'user' as const,
        content: `Current ramp angle: ${ask.rampAngleDeg.toFixed(1)}°. Blocks on the table: ${blocks}. Steepest allowed: ${MAX_RAMP_ANGLE_DEG}°.\nWhat if: ${ask.text}`,
      },
    ],
    text: { format: { type: 'json_schema' as const, name: 'whatif_edit', schema, strict: true } },
  };
}

/** Reads Muse Spark's reply into a validated edit, or says why it is refused. */
export function readWhatIfReply(response: unknown, ask: WhatIfAsk): WhatIfAnswer {
  const parsedResponse = sparkResponseSchema.safeParse(response);
  if (!parsedResponse.success) return { ok: false, error: 'Muse Spark replied in an unexpected shape' };
  let json: unknown;
  try {
    json = JSON.parse(outputText(parsedResponse.data));
  } catch {
    return { ok: false, error: 'Muse Spark did not reply with JSON' };
  }
  const reply = whatIfReplySchema.safeParse(json);
  if (!reply.success) return { ok: false, error: 'Muse Spark replied with something other than an edit' };
  const { note, ...edit } = reply.data;
  const checked = validateEdit(edit, ask.blocks.map((b) => b.id));
  if (!checked.ok) return { ok: false, error: note ? `${checked.error} (Muse Spark: ${note})` : checked.error };
  return { ...checked, note };
}
