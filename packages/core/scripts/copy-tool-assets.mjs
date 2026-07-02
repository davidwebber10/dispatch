#!/usr/bin/env node
// Copy non-TS build assets for the bundled-tools subsystem into dist/.
// Cross-platform replacement for `mkdir -p dist/tools && cp …` (POSIX-only,
// broke the Windows build). Resolves paths relative to packages/core so it
// works regardless of the invoking CWD.
import { mkdirSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const coreRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(join(coreRoot, 'dist', 'tools'), { recursive: true });
copyFileSync(
  join(coreRoot, 'src', 'tools', 'default-tools.json'),
  join(coreRoot, 'dist', 'tools', 'default-tools.json'),
);
