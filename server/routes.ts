import { buildObjectPrompt, parseVideoStream } from '@meta-sam/parser';
import { z } from 'zod';
import { outputText, sparkRequestSchema, sparkResponseSchema } from '../src/agent/sparkWire';
import { GROUNDING_PROMPT, groundingTextFormat } from '../src/scene/groundingPrompt';
import { groundedSceneSchema, hasUsableScale } from '../src/scene/schema';
import { readWhatIfReply, whatIfAskSchema, whatIfSparkRequest } from '../src/whatif/textEdit';
import { trackRequestSchema, sceneRequestSchema, SAM_MODEL, SPARK_MODEL } from '../src/api/contract';
import { json, postResponses, upstreamError, type Route } from './api';

const MB = 1024 * 1024;

/**
 * Server-sent events from a streaming Responses call, as the objects
 * `@meta-sam/parser` reads. Comment lines and `[DONE]` are skipped.
 */
export async function* sseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<{ readonly type: string }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const parse = function* (block: string) {
    const data = block
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, ''))
      .join('\n');
    if (!data || data === '[DONE]') return;
    const event = JSON.parse(data) as unknown;
    if (event && typeof event === 'object' && typeof (event as { type?: unknown }).type === 'string') yield event as { type: string };
  };
  for (;;) {
    const { done, value } = await reader.read();
    buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
    buffer = buffer.replace(/\r\n?/g, '\n');
    let end: number;
    while ((end = buffer.indexOf('\n\n')) >= 0) {
      yield* parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 2);
    }
    if (done) break;
  }
  if (buffer.trim()) yield* parse(buffer);
}

/** `/api/agent`: one fitting-agent turn, forwarded only if it is the agent's own request shape (replaces day 3's `/api/spark`). */
export const agentRoute: Route<z.infer<typeof sparkRequestSchema>> = {
  name: 'agent',
  maxBodyBytes: 256 * 1024,
  // A fit is at most 6 iterations of up to 5 model calls.
  perHour: 150,
  timeoutMs: 60_000,
  input: sparkRequestSchema,
  async call(request, upstream, signal) {
    const res = await postResponses(upstream, request, signal);
    return { status: res.status, body: await res.text() };
  },
};

/** `/api/scene`: Muse Spark grounding of frame 0 into the scene file the page loads (the same shape `smoke-spark.ts` writes). */
export const sceneRoute: Route<z.infer<typeof sceneRequestSchema>> = {
  name: 'scene',
  maxBodyBytes: 4 * MB,
  perHour: 20,
  timeoutMs: 90_000,
  input: sceneRequestSchema,
  async call({ image, imageSize, markerDistanceCm }, upstream, signal) {
    const res = await postResponses(
      upstream,
      {
        model: SPARK_MODEL,
        input: [
          {
            type: 'message',
            role: 'user',
            content: [
              { type: 'input_text', text: GROUNDING_PROMPT },
              { type: 'input_image', image_url: image },
            ],
          },
        ],
        text: { format: groundingTextFormat() },
      },
      signal,
    );
    if (!res.ok) return upstreamError(res);
    const response = sparkResponseSchema.safeParse(await res.json());
    if (!response.success) return json(502, { error: 'Muse Spark replied in an unexpected shape' });
    let raw: unknown;
    try {
      raw = JSON.parse(outputText(response.data));
    } catch {
      return json(422, { error: 'Muse Spark did not reply with JSON' });
    }
    const scene = groundedSceneSchema.safeParse(raw);
    if (!scene.success) return json(422, { error: `the scene does not match the schema: ${scene.error.issues[0]?.message ?? ''}` });
    if (!hasUsableScale(scene.data)) return json(422, { error: 'the two tape marks were not found far enough apart to give a scale' });
    return json(200, { imageSize, markerDistanceCm, scene: scene.data });
  },
};

/**
 * `/api/track`: SAM 3.1 tracking of the clip from box prompts on frame 0,
 * streamed and parsed with `@meta-sam/parser`, answered as the raw output
 * the page parses (what `smoke-sam.ts` saves as sam-raw.txt). The clip comes
 * inline as a data URL; a Vercel function takes at most 4.5 MB of body, so
 * the deployed upload path needs a short, small clip (the presets need none).
 */
export const trackRoute: Route<z.infer<typeof trackRequestSchema>> = {
  name: 'track',
  // A 50 MB clip (spec §6.1) as base64, on the dev server.
  maxBodyBytes: 70 * MB,
  perHour: 6,
  timeoutMs: 280_000,
  input: trackRequestSchema,
  async call({ video, size, objects }, upstream, signal) {
    const prompt = buildObjectPrompt({ size, objects: objects.map((o) => ({ id: o.id, prompts: [{ frame: 0, box: o.box }] })) });
    const res = await postResponses(
      upstream,
      {
        model: SAM_MODEL,
        stream: true,
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt }, { type: 'input_video', video_url: video }] }],
        // Metadata values are strings: include_confidence is "true", not a boolean.
        metadata: { include_confidence: 'true', propagation_direction: 'forward', mask_encoding: 'one_bit' },
      },
      signal,
    );
    if (!res.ok || !res.body) return upstreamError(res);
    let result;
    try {
      result = await parseVideoStream(sseEvents(res.body)).finalResult;
    } catch (err) {
      if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) throw err;
      return json(502, { error: `the SAM 3.1 stream failed: ${err instanceof Error ? err.message : String(err)}` });
    }
    return json(200, {
      rawOutput: result.rawOutput,
      outcome: result.outcome,
      errors: result.diagnostics.filter((d) => d.severity === 'error').length,
    });
  },
};

/** `/api/whatif`: a typed what-if turned into a zod-validated scene edit by Muse Spark (structured output). */
export const whatIfRoute: Route<z.infer<typeof whatIfAskSchema>> = {
  name: 'whatif',
  maxBodyBytes: 16 * 1024,
  perHour: 30,
  timeoutMs: 60_000,
  input: whatIfAskSchema,
  async call(ask, upstream, signal) {
    const res = await postResponses(upstream, whatIfSparkRequest(ask), signal);
    if (!res.ok) return upstreamError(res);
    const answer = readWhatIfReply(await res.json(), ask);
    return answer.ok ? json(200, { edit: answer.edit, note: answer.note }) : json(422, { error: answer.error });
  },
};
