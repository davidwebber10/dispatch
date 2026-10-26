import { describe, it, expect } from 'vitest';
import { inheritedEnv } from '../../src/platform/inherited-env.js';

describe('inheritedEnv', () => {
  it("copies the daemon's environment without PORT, and leaves the source alone", () => {
    const src = { PATH: '/bin', PORT: '3456', HOME: '/h' };
    expect(inheritedEnv(src)).toEqual({ PATH: '/bin', HOME: '/h' });
    expect(src.PORT).toBe('3456');
  });

  it('drops the box tokens and the thread key variables', () => {
    const src = { PATH: '/bin', DISPATCH_BOX_TOKEN: 'a', OS_BOX_TOKEN: 'b', DISPATCH_AUTH: 'c', DISPATCH_AUTH_FILE: '/f', DISPATCH_API: 'http://127.0.0.1:1' };
    expect(inheritedEnv(src)).toEqual({ PATH: '/bin', DISPATCH_API: 'http://127.0.0.1:1' });
  });
});
