import { describe, test, expect } from 'vitest';
import { detectWsl, createWslPlatform } from '../../src/platform/wsl.js';

describe('detectWsl', () => {
  test('true when WSL_DISTRO_NAME is set', () => {
    expect(detectWsl({ WSL_DISTRO_NAME: 'Ubuntu' } as NodeJS.ProcessEnv, () => '')).toBe(true);
  });
  test('true when /proc/version mentions microsoft', () => {
    expect(detectWsl({} as NodeJS.ProcessEnv, () => 'Linux version 5.15.153.1-microsoft-standard-WSL2')).toBe(true);
  });
  test('false on plain linux', () => {
    expect(detectWsl({} as NodeJS.ProcessEnv, () => 'Linux version 6.8.0-generic')).toBe(false);
  });
  test('false when /proc/version is unreadable', () => {
    expect(detectWsl({} as NodeJS.ProcessEnv, () => { throw new Error('ENOENT'); })).toBe(false);
  });
});

describe('wsl platform', () => {
  test('is linux with flavor wsl', () => {
    const p = createWslPlatform();
    expect(p.id).toBe('linux');
    expect(p.logDir()).toContain('.dispatch');
  });
});
