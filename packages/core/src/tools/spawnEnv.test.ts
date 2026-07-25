import { describe, expect, test } from 'vitest';
import { getToolsSpawnEnv } from './spawnEnv.js';

describe('getToolsSpawnEnv PATH composition', () => {
  test('tools bin is prepended to the SHIM path, preserving the shim bin dir', () => {
    const shimEnv = { BROWSER: 'dispatch-open', PATH: '/home/u/.dispatch/bin:/usr/bin' };
    const tools = getToolsSpawnEnv({ base: '/home/u/.dispatch/tools', env: { ...process.env, ...shimEnv } });
    const merged = { ...shimEnv, ...tools };
    expect(merged.PATH).toContain('/home/u/.dispatch/bin');
    expect(merged.PATH.indexOf('tools')).toBeLessThan(merged.PATH.indexOf('.dispatch/bin'));
  });

  test('regression: defaulting to process.env drops the shim bin dir', () => {
    const shimEnv = { BROWSER: 'dispatch-open', PATH: '/home/u/.dispatch/bin:/usr/bin' };
    const tools = getToolsSpawnEnv({ base: '/home/u/.dispatch/tools' }); // old behaviour
    const merged = { ...shimEnv, ...tools };
    expect(merged.PATH).not.toContain('/home/u/.dispatch/bin');
  });
});
