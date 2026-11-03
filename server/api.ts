import { createHash } from 'node:crypto';
import type { z } from 'zod';
import { DailyCap, RateLimiter, ReplyCache, type Clock } from './limits';

/** Meta Model API: OpenAI-compatible Responses API (dev.meta.ai/docs/quickstart). */
export const META_BASE_URL = 'https://api.meta.ai/v1';

export const ROUTE_NAMES = ['track', 'scene', 'agent', 'whatif'] as const;
export type RouteName = (typeof ROUTE_NAMES)[number];

/** One request as the thin server sees it, whichever host (Vite dev server or a Vercel function) received it. */
export interface ApiRequest {
  readonly method: string;
  readonly body: string;
  /** The host stopped reading the body past the route's limit. */
  readonly bodyTooLarge?: boolean;
  /** The caller's address, for the per-caller rate limit. */
  readonly clientIp: string;
}

export interface ApiReply {
  readonly status: number;
  readonly body: string;
  readonly headers: Readonly<Record<string, string>>;
}

/**
 * Server settings, read from the environment only. The key is never put in a
 * reply or a log line.
 */
export interface ApiEnv {
  readonly apiKey: string | undefined;
  readonly baseUrl: string;
  /** Kill switch (build plan: "kill switch → presets only"): every route answers 503. */
  readonly apiOff: boolean;
  /** Calls that may reach the Meta Model API per UTC day, all routes of this process together. */
  readonly dailyCap: number;
}

export const DEFAULT_DAILY_CAP = 400;

export function envFrom(source: Readonly<Record<string, string | undefined>>): ApiEnv {
  const cap = Number(source.PHYSICS_TWIN_DAILY_CAP);
  return {
    apiKey: source.MODEL_API_KEY?.trim() || undefined,
    baseUrl: (source.META_API_BASE_URL?.trim() || META_BASE_URL).replace(/\/$/, ''),
    apiOff: ['1', 'true', 'yes', 'on'].includes(source.PHYSICS_TWIN_API_OFF?.trim().toLowerCase() ?? ''),
    dailyCap: Number.isFinite(cap) && cap >= 0 ? Math.floor(cap) : DEFAULT_DAILY_CAP,
  };
}

/** What a route's upstream call returns. Only a 200 is cached. */
export interface Outcome {
  readonly status: number;
  /** JSON text. */
  readonly body: string;
}

export interface Upstream {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly fetchImpl: typeof fetch;
}

export interface Route<I> {
  readonly name: RouteName;
  /** Request bodies longer than this are refused with 413. */
  readonly maxBodyBytes: number;
  /** Calls that reach the API per caller per hour; cache hits do not count. */
  readonly perHour: number;
  readonly timeoutMs: number;
  readonly input: z.ZodType<I>;
  call(input: I, upstream: Upstream, signal: AbortSignal): Promise<Outcome>;
}

export const json = (status: number, value: unknown): Outcome => ({ status, body: JSON.stringify(value) });
const errorOutcome = (status: number, error: string) => json(status, { error });

/** POSTs one Responses API request with the key from the environment. */
export function postResponses(upstream: Upstream, body: unknown, signal: AbortSignal): Promise<Response> {
  return upstream.fetchImpl(`${upstream.baseUrl}/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${upstream.apiKey}` },
    body: JSON.stringify(body),
    signal,
  });
}

/** An upstream error as the page sees it: the status and the start of the API's own message. */
export async function upstreamError(res: Response): Promise<Outcome> {
  const text = await res.text().catch(() => '');
  return json(502, { error: `Meta Model API answered ${res.status}`, detail: text.slice(0, 300) });
}

export interface ApiDeps {
  readonly env: ApiEnv;
  readonly fetchImpl?: typeof fetch;
  readonly now?: Clock;
  /** Shared by every route of one process, so the cap is for the whole server. */
  readonly dailyCap?: DailyCap;
}

const CACHE_ENTRIES = 200;
const CACHE_TTL_MS = 24 * 3600 * 1000;
const HOUR_MS = 3600 * 1000;

/**
 * Wraps a route with the thin server's checks, in this order: kill switch,
 * method, body size, JSON, the route's zod schema, the cache (a hit is
 * answered without the API and without counting against any limit), the
 * key, the caller's hourly limit, the daily cap, then the call.
 */
export function createRouteHandler<I>(route: Route<I>, deps: ApiDeps): (req: ApiRequest) => Promise<ApiReply> {
  const now = deps.now ?? Date.now;
  const cache = new ReplyCache<Outcome>(CACHE_ENTRIES, CACHE_TTL_MS, now);
  const perCaller = new RateLimiter(route.perHour, HOUR_MS, now);
  const daily = deps.dailyCap ?? new DailyCap(deps.env.dailyCap, now);
  const fetchImpl = deps.fetchImpl ?? fetch;

  const reply = (outcome: Outcome, headers: Record<string, string> = {}): ApiReply => ({
    status: outcome.status,
    body: outcome.body,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers },
  });

  return async (req) => {
    if (deps.env.apiOff) return reply(errorOutcome(503, 'the Model API is switched off on this server; the recorded presets still work'));
    if (req.method !== 'POST') return reply(errorOutcome(405, 'POST only'), { allow: 'POST' });
    if (req.bodyTooLarge || Buffer.byteLength(req.body) > route.maxBodyBytes) {
      return reply(errorOutcome(413, `request larger than ${Math.floor(route.maxBodyBytes / 1024)} kB`));
    }
    let raw: unknown;
    try {
      raw = JSON.parse(req.body);
    } catch {
      return reply(errorOutcome(400, 'request is not JSON'));
    }
    const parsed = route.input.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return reply(errorOutcome(400, `not a ${route.name} request: ${issue?.path.join('.') ?? ''} ${issue?.message ?? ''}`.trim()));
    }

    const key = createHash('sha256').update(route.name).update('\0').update(JSON.stringify(parsed.data)).digest('hex');
    const cached = cache.get(key);
    if (cached) return reply(cached, { 'x-cache': 'hit' });

    const apiKey = deps.env.apiKey;
    if (!apiKey) return reply(errorOutcome(503, 'MODEL_API_KEY is not set on this server'));
    const mine = perCaller.take(req.clientIp);
    if (!mine.ok) return reply(errorOutcome(429, `rate limit: ${route.perHour} ${route.name} calls an hour`), { 'retry-after': String(mine.retryAfterSec) });
    const today = daily.take();
    if (!today.ok) return reply(errorOutcome(429, 'the server has reached its daily Model API cap'), { 'retry-after': String(today.retryAfterSec) });

    let outcome: Outcome;
    try {
      outcome = await route.call(parsed.data, { apiKey, baseUrl: deps.env.baseUrl, fetchImpl }, AbortSignal.timeout(route.timeoutMs));
    } catch (err) {
      const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
      return reply(errorOutcome(timedOut ? 504 : 502, timedOut ? 'the Model API took too long' : 'could not reach the Model API'));
    }
    if (outcome.status === 200) cache.set(key, outcome);
    return reply(outcome, { 'x-cache': 'miss' });
  };
}
