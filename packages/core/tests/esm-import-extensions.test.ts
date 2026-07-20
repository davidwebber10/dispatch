import { describe, expect, test } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

/**
 * Guards a class of bug the build genuinely cannot catch.
 *
 * This package compiles with `moduleResolution: "bundler"`, which accepts an extensionless
 * relative specifier (`./task-notification`) and emits it verbatim. But the package is
 * `"type": "module"` and runs directly under Node, whose ESM resolver requires the real
 * filename. So `tsc` succeeds, every vitest suite passes (vitest resolves like a bundler
 * too), and the daemon then dies at startup with ERR_MODULE_NOT_FOUND.
 *
 * That is not hypothetical: it shipped in v2.8.2 and made the built daemon unloadable.
 * Nothing in the build or the test suite noticed, which is exactly why this check is static
 * — it reads the source rather than relying on a resolver that is more forgiving than Node.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(here, '..', 'src');

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...tsFiles(p));
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

// `from './x'` / `from '../x'` in a static import or re-export, plus dynamic `import('./x')`.
const SPECIFIER = /(?:from\s*|import\s*\()\s*['"](\.[^'"]*)['"]/g;

describe('ESM import extensions', () => {
  test('every relative import in src/ carries an explicit extension Node can resolve', () => {
    const offenders: string[] = [];
    for (const file of tsFiles(SRC)) {
      if (file.endsWith('.test.ts')) continue; // tests are never loaded by Node directly
      const text = fs.readFileSync(file, 'utf8');
      for (const m of text.matchAll(SPECIFIER)) {
        const spec = m[1];
        if (/\.(js|json|css)$/.test(spec)) continue;
        offenders.push(`${path.relative(SRC, file)} -> ${spec}`);
      }
    }
    // Named individually so a failure says exactly which import to fix.
    expect(offenders).toEqual([]);
  });
});
