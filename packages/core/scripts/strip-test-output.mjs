#!/usr/bin/env node
// Removes test and fixture output from dist/ after `tsc`.
//
// The build config excludes `src/**/*.test.ts` and `src/**/*.fixture.ts`, so a new build does not
// emit them. But the build does not delete dist/: `dispatch update` rebuilds under a live daemon,
// and a wiped dist/ can break a lazy import. So the output of an older build stays until this
// script removes it. It removes only `*.test.*` and `*.fixture.*` build output, nothing else.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const STALE = /\.(test|fixture)\.(js|js\.map|d\.ts|d\.ts\.map)$/;

/**
 * @param {string} distDir
 * @returns {string[]} the absolute paths of the files that were removed
 */
export function stripTestOutput(distDir) {
  const removed = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      if (err && err.code === 'ENOENT') return;
      throw err;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && STALE.test(e.name)) {
        fs.rmSync(p, { force: true });
        removed.push(p);
      }
    }
  };
  walk(distDir);
  return removed;
}

const self = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === self) {
  const dist = path.resolve(process.argv[2] ?? path.join(path.dirname(self), '..', 'dist'));
  const removed = stripTestOutput(dist);
  if (removed.length > 0) console.log(`strip-test-output: removed ${removed.length} stale test file(s) from ${dist}`);
}
