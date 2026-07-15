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
  it('hostPlatformKey is a darwin key on this platform', () => {
    expect(['darwin-arm64', 'darwin-x64']).toContain(hostPlatformKey());
  });
  it('hostPlatformKey delegates to platform.toolPlatformKey()', () => {
    expect(hostPlatformKey()).toBe(platform.toolPlatformKey());
  });
});
