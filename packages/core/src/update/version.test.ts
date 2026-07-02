import { describe, it, expect } from 'vitest';
import { getRunningVersion, isNewerVersion } from './version.js';

describe('getRunningVersion', () => {
  it('reads the version from packages/core/package.json', () => {
    expect(getRunningVersion()).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe('isNewerVersion', () => {
  it('is true when the candidate has a higher patch/minor/major', () => {
    expect(isNewerVersion('1.0.1', '1.0.0')).toBe(true);
    expect(isNewerVersion('1.1.0', '1.0.9')).toBe(true);
    expect(isNewerVersion('2.0.0', '1.9.9')).toBe(true);
  });

  it('is false when equal or older', () => {
    expect(isNewerVersion('1.0.0', '1.0.0')).toBe(false);
    expect(isNewerVersion('1.0.0', '1.0.1')).toBe(false);
    expect(isNewerVersion('0.9.0', '1.0.0')).toBe(false);
  });

  it('tolerates a leading "v" on either side', () => {
    expect(isNewerVersion('v1.0.1', '1.0.0')).toBe(true);
    expect(isNewerVersion('v1.0.0', 'v1.0.0')).toBe(false);
  });
});
