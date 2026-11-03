import { envFrom, type RouteName } from './api.js';
import { createApi, type ApiHandler } from './index.js';

let handlers: Readonly<Record<RouteName, ApiHandler>> | null = null;

/** The caller's address as Vercel's edge reports it. */
function clientIp(request: Request): string {
  return request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || request.headers.get('x-real-ip')?.trim() || 'unknown';
}

/**
 * A Vercel function (Web `Request` → `Response`) for one route. The handlers,
 * with their cache and limits, are made on the first request and live as
 * long as the warm instance.
 */
export function vercelRoute(name: RouteName) {
  return async (request: Request): Promise<Response> => {
    handlers ??= createApi({ env: envFrom(process.env) });
    const reply = await handlers[name]({ method: request.method, body: await request.text(), clientIp: clientIp(request) });
    return new Response(reply.body, { status: reply.status, headers: reply.headers });
  };
}
