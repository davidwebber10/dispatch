#!/usr/bin/env node
/**
 * Ensure node-pty's `spawn-helper` is executable after install.
 *
 * node-pty ships its prebuilt `spawn-helper` binary with mode 0644 in the npm
 * tarball and has no install step that restores the executable bit for the
 * prebuild path. Under pnpm the bit is not recovered, so on macOS/Linux
 * `pty.spawn()` fails at runtime with "posix_spawnp failed" because the helper
 * cannot be executed. (A source compile via node-gyp would produce an
 * executable helper, but we rely on the shipped prebuilt binaries.)
 *
 * This runs as the workspace-root `postinstall`, so it executes on every
 * `pnpm install` on every host. It is a no-op on Windows, which uses ConPTY and
 * never execs `spawn-helper`.
 */
import { chmodSync, existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

if (process.platform === 'win32') {
  process.exit(0); // ConPTY: no spawn-helper to fix
}

const root = dirname(fileURLToPath(import.meta.url));
// Resolve the node-pty actually used by the server package.
const require = createRequire(join(root, '..', 'packages', 'core', 'package.json'));

let pkgPath;
try {
  pkgPath = require.resolve('node-pty/package.json');
} catch {
  // node-pty not installed (e.g. partial install) — nothing to do.
  process.exit(0);
}

const ptyDir = dirname(pkgPath);
const candidates = [
  join(ptyDir, `prebuilds/${process.platform}-${process.arch}/spawn-helper`),
  join(ptyDir, 'build/Release/spawn-helper'),
];

let fixed = 0;
for (const file of candidates) {
  if (!existsSync(file)) continue;
  const mode = statSync(file).mode;
  // Add execute bits for user/group/other (0o111) if any are missing.
  if ((mode & 0o111) !== 0o111) {
    chmodSync(file, mode | 0o755);
    console.log(`fix-node-pty-perms: chmod +x ${file}`);
    fixed++;
  }
}

if (fixed === 0) {
  console.log('fix-node-pty-perms: spawn-helper already executable (or not present)');
}
