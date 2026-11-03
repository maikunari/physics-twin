import { z } from 'zod';
import { sceneFileSchema } from '../overlay/overlayData';
import type { WhatIfAsk } from '../whatif/textEdit';
import { trackReplySchema, type SceneRequest, type TrackReply, type TrackRequest } from './contract';

/** The thin server's routes, relative to the page (the Vite dev server, or Vercel functions under /api). */
async function post<T>(path: string, body: unknown, schema: z.ZodType<T>, fetchImpl: typeof fetch): Promise<T> {
  const res = await fetchImpl(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`${path} answered ${res.status} without JSON`);
  }
  if (!res.ok) {
    const error = (json as { error?: unknown }).error;
    throw new Error(`${path} answered ${res.status}: ${typeof error === 'string' ? error : text.slice(0, 200)}`);
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw new Error(`${path} answered in an unexpected shape`);
  return parsed.data;
}

export const sceneFromApi = (request: SceneRequest, fetchImpl: typeof fetch = fetch) =>
  post('/api/scene', request, sceneFileSchema, fetchImpl);

export const trackFromApi = (request: TrackRequest, fetchImpl: typeof fetch = fetch): Promise<TrackReply> =>
  post('/api/track', request, trackReplySchema, fetchImpl);

// The edit is left unchecked here: the what-if machine validates it and shows why it is refused.
const whatIfReplySchema = z.object({ edit: z.unknown(), note: z.string() });

/** Muse Spark's edit for a typed what-if; the page's what-if machine checks it again before it runs. */
export const whatIfFromApi = (ask: WhatIfAsk, fetchImpl: typeof fetch = fetch) => post('/api/whatif', ask, whatIfReplySchema, fetchImpl);
