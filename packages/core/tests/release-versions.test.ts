import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// A release cut by hand once bumped only the root package.json (4.7.8) and left core, cli and web on
// 4.7.7. The daemon reports its version from packages/core, so every install that took the release
// offered the same update again. `dispatch release` checks the four files, but a hand cut skips it:
// this test makes that visible in CI before the mismatch ships. Releases go only through
// `dispatch release` (docs/RELEASING.md).
const root = fileURLToPath(new URL('../../..', import.meta.url));
const FILES = ['package.json', 'packages/cli/package.json', 'packages/core/package.json', 'packages/web/package.json'];

describe('the four package.json versions', () => {
  const versions = FILES.map((rel) => ({ rel, version: String(JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8')).version) }));

  it('are plain semver', () => {
    for (const v of versions) expect(v.version, v.rel).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('all match (root, cli, core, web)', () => {
    const mismatched = versions.filter((v) => v.version !== versions[0].version);
    expect(mismatched.map((v) => `${v.rel} is ${v.version}, root is ${versions[0].version}`)).toEqual([]);
  });
});
