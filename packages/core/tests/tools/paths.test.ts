import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { toolPaths, hostPlatformKey } from '../../src/tools/paths.js';
import { platform } from '../../src/platform/index.js';

describe('tool paths', () => {
  it('defaults under ~/.dispatch/tools', () => {
    const p = toolPaths();
    expect(p.dir).toBe(path.join(os.homedir(), '.dispatch', 'tools'));
    expect(p.bin).toBe(path.join(p.dir, 'bin'));
    expect(p.installed).toBe(path.join(p.dir, 'installed.json'));
    expect(p.userManifest).toBe(path.join(os.homedir(), '.dispatch', 'tools.json'));
  });
  it('honors a base override (for tests)', () => {
    const p = toolPaths('/tmp/x');
    expect(p.dir).toBe('/tmp/x');
    expect(p.bin).toBe('/tmp/x/bin');
  });
  it('hostPlatformKey reflects the host OS family and architecture', () => {
    // Derived from the host, not hardcoded: this suite runs on macOS dev machines AND
    // linux CI runners, where a darwin-only expectation fails even though the code is
    // right. WSL reports linux keys too (platform/index.ts picks wsl only as a linux
    // sub-flavor), so the family for any non-darwin host here is 'linux'.
    const family = process.platform === 'darwin' ? 'darwin' : 'linux';
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
    expect(hostPlatformKey()).toBe(`${family}-${arch}`);
  });
  it('hostPlatformKey delegates to platform.toolPlatformKey()', () => {
    expect(hostPlatformKey()).toBe(platform.toolPlatformKey());
  });
});
