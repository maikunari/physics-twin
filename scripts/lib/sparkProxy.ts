import { sparkRequestSchema, type SparkTransport } from '../../src/agent/sparkWire';

/** Requests bigger than this are refused before parsing; a fitting turn is a few kB. */
export const MAX_PROXY_BODY_BYTES = 256 * 1024;

export interface ProxyReply {
  readonly status: number;
  readonly body: string;
}

export interface ProxyConfig {
  readonly apiKey: string | undefined;
  /** The Responses API base URL, e.g. https://api.meta.ai/v1. */
  readonly baseUrl: string;
  readonly fetchImpl?: typeof fetch;
}

const reply = (status: number, error: string): ProxyReply => ({ status, body: JSON.stringify({ error }) });

/**
 * The dev server's `/api/spark`: forwards one fitting-agent request to the
 * Meta Model API with the key from the server's environment, so the page
 * never holds it. Only the agent's own request shape passes (zod), so it is
 * not a general proxy to the API. The deployed `/api/agent` (spec §5, day 5)
 * replaces it.
 */
export async function proxySparkRequest(rawBody: string, config: ProxyConfig): Promise<ProxyReply> {
  if (!config.apiKey) return reply(503, 'MODEL_API_KEY is not set on the dev server; the fit runs numeric-only');
  if (rawBody.length > MAX_PROXY_BODY_BYTES) return reply(413, 'request too large');
  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    return reply(400, 'request is not JSON');
  }
  const request = sparkRequestSchema.safeParse(json);
  if (!request.success) return reply(400, `not a fitting-agent request: ${request.error.issues[0]?.message ?? ''}`);

  const res = await (config.fetchImpl ?? fetch)(`${config.baseUrl.replace(/\/$/, '')}/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${config.apiKey}` },
    body: JSON.stringify(request.data),
  });
  return { status: res.status, body: await res.text() };
}

/** The fitting agent's transport for a terminal script: the same validated request shape and forwarding as `/api/spark`. */
export function scriptSparkTransport(config: ProxyConfig): SparkTransport {
  return async (request) => {
    const answer = await proxySparkRequest(JSON.stringify(request), config);
    if (answer.status !== 200) throw new Error(`Meta Model API answered ${answer.status}: ${answer.body.slice(0, 200)}`);
    return JSON.parse(answer.body) as unknown;
  };
}
