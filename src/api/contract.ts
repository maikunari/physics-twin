import { z } from 'zod';
import { SPARK_AGENT_MODEL } from '../agent/sparkWire.js';
import { DEFAULT_MARKER_DISTANCE_CM } from '../scene/calibration.js';

export const SAM_MODEL = 'sam-3.1';
export const SPARK_MODEL = SPARK_AGENT_MODEL;

/** A base64 data URL of one of the given media types; only its head is pattern-checked, since a clip runs to megabytes. */
const dataUrl = (types: RegExp, what: string) =>
  z.string().refine((s) => types.test(s.slice(0, 48)), { message: `must be a base64 data URL of ${what}` });

const sizeSchema = z.strictObject({
  width: z.number().int().min(16).max(8192),
  height: z.number().int().min(16).max(8192),
});

/** `/api/scene`: frame 0 of the clip, as the browser drew it (rotation applied). */
export const sceneRequestSchema = z.strictObject({
  image: dataUrl(/^data:image\/(jpeg|png);base64,/, 'a JPEG or PNG'),
  imageSize: sizeSchema,
  markerDistanceCm: z.number().positive().max(500).default(DEFAULT_MARKER_DISTANCE_CM),
});
export type SceneRequest = z.input<typeof sceneRequestSchema>;

const pixelBoxSchema = z
  .strictObject({
    left: z.number().int().min(0),
    top: z.number().int().min(0),
    right: z.number().int().min(1),
    bottom: z.number().int().min(1),
  })
  .refine((b) => b.right > b.left && b.bottom > b.top, { message: 'box must have positive width and height' });

/** `/api/track`: the clip and a frame-0 box per object; the server builds SAM's prompt from them. */
export const trackRequestSchema = z.strictObject({
  video: dataUrl(/^data:video\/(mp4|quicktime);base64,/, 'an MP4 or MOV video'),
  size: sizeSchema,
  /** The ball is object 1, blocks follow (`trackedObjectsFor`). */
  objects: z
    .array(z.strictObject({ id: z.string().regex(/^[1-9][0-9]?$/), box: pixelBoxSchema }))
    .min(1)
    .max(6),
});
export type TrackRequest = z.input<typeof trackRequestSchema>;

export const trackReplySchema = z.object({
  rawOutput: z.string(),
  outcome: z.object({ status: z.string() }),
  errors: z.number(),
});
export type TrackReply = z.infer<typeof trackReplySchema>;
