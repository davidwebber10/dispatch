import { describe, expect, test, vi } from 'vitest';
import { resolveLoginPathWith, withDirFirst } from '../../src/platform/darwin.js';

const wrap = (p: string) => `noise__DISPATCH_PATH_START__${p}__DISPATCH_PATH_END__`;

describe('resolveLoginPathWith', () => {
  test('keeps the daemon node dir first when the login shell puts an fnm shim ahead of it', () => {
    const shell = '/home/u/.local/state/fnm_multishells/123_1/bin:/usr/bin:/home/u/.local/share/fnm/node-versions/v24.14.0/installation/bin:/bin';
    const run = vi.fn(() => wrap(shell));
    const out = resolveLoginPathWith(run as any, '/bin/bash', '/home/u/.local/share/fnm/node-versions/v24.14.0/installation/bin/node', '/home/u');
    expect(out!.split(':')[0]).toBe('/home/u/.local/share/fnm/node-versions/v24.14.0/installation/bin');
    expect(out!.split(':').filter(d => d.includes('v24.14.0'))).toHaveLength(1);
    expect(out).toContain('fnm_multishells');
  });

  test('runs the login shell from the home dir, so cd hooks do not read the repo .nvmrc', () => {
    const run = vi.fn(() => wrap('/usr/bin'));
    resolveLoginPathWith(run as any, '/bin/bash', '/n/bin/node', '/home/u');
    expect((run.mock.calls[0] as any)[2].cwd).toBe('/home/u');
  });

  test('undefined when the shell fails or prints no PATH', () => {
    expect(resolveLoginPathWith((() => { throw new Error('x'); }) as any, undefined, '/n/bin/node', '/h')).toBeUndefined();
    expect(resolveLoginPathWith((() => 'nothing') as any, undefined, '/n/bin/node', '/h')).toBeUndefined();
  });

  test('withDirFirst drops empty entries and the later copy', () => {
    expect(withDirFirst('/a::/b:/a', '/a')).toBe('/a:/b');
  });
});
