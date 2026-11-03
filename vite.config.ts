/// <reference types="vitest/config" />
import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { envFrom } from './server/api';
import { apiMiddleware } from './server/node';

/**
 * The thin server's routes (`/api/track`, `/api/scene`, `/api/agent`,
 * `/api/whatif`) on the dev and preview servers, with MODEL_API_KEY from the shell or a
 * git-ignored `.env.local`; it never reaches the page.
 */
function thinServer(env: Record<string, string>): Plugin {
  return {
    name: 'physics-twin-thin-server',
    configureServer(server) {
      server.middlewares.use(apiMiddleware(envFrom(env)));
    },
    // `npm run preview` serves the production build with the same routes, as Vercel does.
    configurePreviewServer(server) {
      server.middlewares.use(apiMiddleware(envFrom(env)));
    },
  };
}

export default defineConfig(({ mode }) => {
  // '' loads every variable, not only VITE_ ones; none of them is exposed to the page.
  const env = { ...loadEnv(mode, process.cwd(), ''), ...process.env } as Record<string, string>;
  return {
    plugins: [react(), thinServer(env)],
    test: {
      include: ['src/**/*.test.ts', 'scripts/**/*.test.ts', 'server/**/*.test.ts'],
      environment: 'node',
    },
  };
});
