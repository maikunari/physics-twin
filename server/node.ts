import type { IncomingMessage, ServerResponse } from 'node:http';
import { ROUTE_NAMES, type ApiEnv, type RouteName } from './api';
import { createApi, MAX_BODY_BYTES } from './index';

/** Reads the body up to `limit` bytes; past it the rest is drained and dropped, and the request marked too large. */
function readBody(req: IncomingMessage, limit: number): Promise<{ body: string; tooLarge: boolean }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) tooLarge = true;
      else chunks.push(chunk);
    });
    req.on('end', () => resolve({ body: tooLarge ? '' : Buffer.concat(chunks).toString('utf8'), tooLarge }));
    req.on('error', reject);
  });
}

export type Middleware = (req: IncomingMessage, res: ServerResponse, next: () => void) => void;

/**
 * The thin server on the Vite dev server: `/api/<route>` runs the same
 * handlers as the Vercel functions, with MODEL_API_KEY from the dev
 * server's environment, so the key never reaches the page.
 */
export function apiMiddleware(env: ApiEnv): Middleware {
  const handlers = createApi({ env });
  return (req, res, next) => {
    const name = /^\/api\/([a-z]+)\/?(?:\?.*)?$/.exec(req.url ?? '')?.[1];
    if (!name || !(ROUTE_NAMES as readonly string[]).includes(name)) return next();
    const route = name as RouteName;
    readBody(req, MAX_BODY_BYTES[route])
      .then(({ body, tooLarge }) =>
        handlers[route]({ method: req.method ?? 'GET', body, bodyTooLarge: tooLarge, clientIp: req.socket.remoteAddress ?? 'local' }),
      )
      .then((reply) => {
        res.writeHead(reply.status, reply.headers);
        res.end(reply.body);
      })
      .catch(() => {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'the dev server could not handle the request' }));
      });
  };
}
