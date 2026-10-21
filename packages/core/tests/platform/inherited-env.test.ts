import { describe, it, expect } from 'vitest';
import { inheritedEnv } from '../../src/platform/inherited-env.js';

describe('inheritedEnv', () => {
  it("copies the daemon's environment without PORT, and leaves the source alone", () => {
    const src = { PATH: '/bin', PORT: '3456', HOME: '/h' };
    expect(inheritedEnv(src)).toEqual({ PATH: '/bin', HOME: '/h' });
    expect(src.PORT).toBe('3456');
  });
});
