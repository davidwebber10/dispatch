import { describe, expect, test } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripTestOutput } from '../../scripts/strip-test-output.mjs';

/**
 * The build must not ship test files. Before this guard, `dist/` held every `*.test.js`
 * (25 in `dist/sessions` alone). Two things keep them out:
 *   1. the build config excludes the test and fixture globs, so `tsc` does not emit them;
 *   2. the build does not delete `dist` (a live daemon lazy-imports from it during an update),
 *      so `strip-test-output.mjs` removes the test output that an older build left behind.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const CORE = path.join(here, '..', '..');

function readJson(file: string): any {
  return JSON.parse(fs.readFileSync(path.join(CORE, file), 'utf8'));
}

describe('no tests in dist', () => {
  test('the build config excludes the test and fixture globs', () => {
    const cfg = readJson('tsconfig.json');
    expect(cfg.exclude).toEqual(expect.arrayContaining(['src/**/*.test.ts', 'src/**/*.fixture.ts']));
  });

  test('the build script strips stale test output and does not delete dist', () => {
    const build: string = readJson('package.json').scripts.build;
    expect(build).toContain('node scripts/strip-test-output.mjs');
    expect(build).not.toMatch(/rm\s+-rf?\s+dist|rimraf/);
  });

  test('stripTestOutput removes only test and fixture output', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'strip-test-output-'));
    try {
      const keep = ['server.js', 'server.d.ts', 'server.js.map', 'sessions/service.js', 'sessions/contest.js', 'sessions/latest.js'];
      const drop = [
        'sessions/service.test.js',
        'sessions/service.test.js.map',
        'sessions/service.test.d.ts',
        'sessions/service.test.d.ts.map',
        'structured/codex-frames.fixture.js',
        'structured/codex-frames.fixture.js.map',
        'structured/codex-frames.fixture.d.ts',
        'structured/codex-frames.fixture.d.ts.map',
      ];
      for (const f of [...keep, ...drop]) {
        fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
        fs.writeFileSync(path.join(dir, f), '');
      }
      const removed = stripTestOutput(dir);
      expect(removed.map((p: string) => path.relative(dir, p)).sort()).toEqual([...drop].sort());
      for (const f of keep) expect(fs.existsSync(path.join(dir, f))).toBe(true);
      for (const f of drop) expect(fs.existsSync(path.join(dir, f))).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('stripTestOutput answers an empty list when dist does not exist', () => {
    expect(stripTestOutput(path.join(os.tmpdir(), 'strip-test-output-missing-' + process.pid))).toEqual([]);
  });
});
