import { describe, test, expect } from 'vitest';
import { darwin } from '../../src/platform/darwin.js';
import { linux } from '../../src/platform/linux.js';
import { createWslPlatform } from '../../src/platform/wsl.js';

const wsl = createWslPlatform({
  execFile: async () => ({ stdout: '' }),
  readFileSync: () => '', env: {} as NodeJS.ProcessEnv,
});

// Every capability the app relies on. Adding a Platform method without listing it
// here fails the exhaustiveness check below — update BOTH, for all platforms.
const CONTRACT = [
  'id', 'flavor', 'fileManagerName', 'defaultShell', 'resolveLoginPath', 'dataDir', 'logDir',
  'resolveCommand', 'listProcessIds', 'claudeProjectDir', 'installBrowserShim', 'daemon',
  'revealInFileManager', 'isLocalClient', 'toolPlatformKey', 'tailscaleStatus',
] as const;

describe.each([['darwin', darwin], ['linux', linux], ['wsl', wsl]] as const)('%s conforms', (_name, p) => {
  test('implements every contract key', () => {
    for (const key of CONTRACT) expect(p[key], `missing ${key}`).toBeDefined();
  });
  test('no keys beyond the contract (exhaustiveness — update CONTRACT and every impl together)', () => {
    expect(Object.keys(p).sort()).toEqual([...CONTRACT].sort());
  });
  test('shared invariants', () => {
    expect(p.dataDir()).toMatch(/\.dispatch$/);
    expect(['macos', 'wsl', 'linux']).toContain(p.flavor);
    expect(p.isLocalClient({ remoteAddress: '8.8.8.8', host: 'evil.com', proxied: false })).toBe(false);
    expect(p.isLocalClient({ remoteAddress: '127.0.0.1', host: 'localhost', proxied: true })).toBe(false);
  });
});
