/// <reference types="vitest/config" />
import type { IncomingMessage } from 'node:http';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { META_BASE_URL } from './scripts/lib/meta';
import { MAX_PROXY_BODY_BYTES, proxySparkRequest } from './scripts/lib/sparkProxy';

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      body += chunk;
      // Stop reading early; the proxy answers 413 for anything this long.
      if (body.length > MAX_PROXY_BODY_BYTES) req.destroy();
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

/**
 * `/api/spark` on the dev server only: the fitting agent's calls go through
 * here so MODEL_API_KEY stays in this process (from the shell or a git-ignored
 * `.env.local`) and never reaches the page.
 */
function sparkDevProxy(env: Record<string, string>): Plugin {
  return {
    name: 'physics-twin-spark-dev-proxy',
    configureServer(server) {
      server.middlewares.use('/api/spark', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end();
          return;
        }
        readBody(req)
          .then((body) =>
            proxySparkRequest(body, {
              apiKey: env.MODEL_API_KEY?.trim() || undefined,
              baseUrl: env.META_API_BASE_URL?.trim() || META_BASE_URL,
            }),
          )
          .then((reply) => {
            res.statusCode = reply.status;
            res.setHeader('content-type', 'application/json');
            res.end(reply.body);
          })
          .catch((err: unknown) => {
            res.statusCode = 502;
            res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
          });
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  // '' loads every variable, not only VITE_ ones; none of them is exposed to the page.
  const env = { ...loadEnv(mode, process.cwd(), ''), ...process.env } as Record<string, string>;
  return {
    plugins: [react(), sparkDevProxy(env)],
    test: {
      include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'],
      environment: 'node',
    },
  };
});
