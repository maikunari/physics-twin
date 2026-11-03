import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const RELATIVE_IMPORT = /(?:from|import)\s*\(?\s*['"](\.[^'"]+)['"]/g;

/**
 * Vercel compiles each `api/*.ts` file on its own and runs it as an ES
 * module (package.json `"type": "module"`), where Node needs the extension
 * on a relative import: `../server/vercel` fails with ERR_MODULE_NOT_FOUND,
 * `../server/vercel.js` loads. Vite and the tests do not care, so this test
 * is what catches it before a deploy.
 */
describe('Vercel function imports', () => {
  it('name the .js file on every relative import the functions load', () => {
    const root = path.resolve('api');
    const queue = readdirSync(root).filter((f) => f.endsWith('.ts')).map((f) => path.join(root, f));
    const seen = new Set<string>();
    const missing: string[] = [];
    while (queue.length) {
      const file = queue.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      for (const [, spec] of readFileSync(file, 'utf8').matchAll(RELATIVE_IMPORT)) {
        if (!spec!.endsWith('.js')) {
          missing.push(`${path.relative(process.cwd(), file)}: '${spec}'`);
          continue;
        }
        const source = path.resolve(path.dirname(file), spec!.replace(/\.js$/, '.ts'));
        expect(existsSync(source), `${file} imports ${spec}`).toBe(true);
        queue.push(source);
      }
    }
    expect(missing).toEqual([]);
    expect(seen.size).toBeGreaterThan(4);
  });
});
