import { vercelRoute } from '../server/vercel.js';

/** `/api/whatif` on Vercel; the same handler runs on the Vite dev server (`vite.config.ts`). */
export const POST = vercelRoute('whatif');
