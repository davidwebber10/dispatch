import { describe, expect, test } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Core and the CLI run directly under Node as ESM. With `moduleResolution: "bundler"` the
 * compiler accepts `./x` and Node then fails at startup (ERR_MODULE_NOT_FOUND, shipped in v2.8.2).
 * NodeNext makes the compiler reject a relative import that has no `.js` extension (TS2835).
 * `tsconfig.base.json` stays on `bundler` because the web package needs it.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const PACKAGES = path.join(here, '..', '..', '..');

function readJson(file: string): any {
  return JSON.parse(fs.readFileSync(path.join(PACKAGES, file), 'utf8'));
}

describe('NodeNext module resolution', () => {
  test.each(['core/tsconfig.json', 'cli/tsconfig.json'])('%s compiles with NodeNext', (file) => {
    const opts = readJson(file).compilerOptions;
    expect(opts.module).toBe('NodeNext');
    expect(opts.moduleResolution).toBe('NodeNext');
  });

  test('the test type-check config extends the build config, emits nothing, and covers src and tests', () => {
    const cfg = readJson('core/tsconfig.test.json');
    expect(cfg.extends).toBe('./tsconfig.json');
    expect(cfg.compilerOptions.noEmit).toBe(true);
    expect(cfg.include).toEqual(expect.arrayContaining(['src', 'tests']));
    // The build config excludes the tests; this config must bring them back.
    expect(cfg.exclude ?? []).not.toContain('src/**/*.test.ts');
  });

  test('the typecheck script runs both configs', () => {
    const typecheck: string = readJson('core/package.json').scripts.typecheck;
    expect(typecheck).toContain('tsc --noEmit');
    expect(typecheck).toContain('tsconfig.test.json');
  });
});
