import { vercelRoute } from '../server/vercel.js';

/** `/api/track` on Vercel; the same handler runs on the Vite dev server (`vite.config.ts`). */
export const POST = vercelRoute('track');
