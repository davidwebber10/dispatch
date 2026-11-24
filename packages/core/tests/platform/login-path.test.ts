import { describe, expect, test, vi } from 'vitest';
import { resolveLoginPathWith } from '../../src/platform/darwin.js';

const wrap = (p: string) => `noise__DISPATCH_PATH_START__${p}__DISPATCH_PATH_END__`;

describe('resolveLoginPathWith', () => {
  test('returns the login shell PATH as it is, in its order (no node dir is moved to the front)', () => {
    const shell = '/home/u/fnm/default/bin:/usr/local/bin:/home/u/.local/share/fnm/node-versions/v24.14.0/installation/bin:/bin';
    const out = resolveLoginPathWith(vi.fn(() => wrap(shell)) as any, '/bin/bash', '/home/u');
    expect(out).toBe(shell);
  });

  test('runs the login shell from the home dir, so cd hooks do not read the repo .nvmrc', () => {
    const run = vi.fn(() => wrap('/usr/bin'));
    resolveLoginPathWith(run as any, '/bin/bash', '/home/u');
    expect((run.mock.calls[0] as any)[2].cwd).toBe('/home/u');
  });

  test('undefined when the shell fails or prints no PATH', () => {
    expect(resolveLoginPathWith((() => { throw new Error('x'); }) as any, undefined, '/h')).toBeUndefined();
    expect(resolveLoginPathWith((() => 'nothing') as any, undefined, '/h')).toBeUndefined();
  });
});
