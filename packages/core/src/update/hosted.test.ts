import { describe, it, expect, vi } from 'vitest';
import {
  applyHostedUpdate,
  checkHostedUpdate,
  hostedTarget,
  type HostedTarget,
} from './hosted.js';

const TARGET: HostedTarget = { baseUrl: 'http://os.internal', boxToken: 'box-secret' };

function fakeFetch(impl: (url: string, init: RequestInit) => Partial<Response>) {
  return vi.fn(async (url: any, init: any) => impl(String(url), init) as Response) as unknown as typeof fetch;
}

describe('hostedTarget', () => {
  it('is null on an ordinary local daemon, so the git path is untouched', () => {
    expect(hostedTarget({} as NodeJS.ProcessEnv)).toBeNull();
  });

  it('needs BOTH the base url and the token — half a configuration is not hosted', () => {
    expect(hostedTarget({ OS_BASE_URL: 'http://os' } as any)).toBeNull();
    expect(hostedTarget({ OS_BOX_TOKEN: 't' } as any)).toBeNull();
  });

  it('trims the trailing slash so paths do not double up', () => {
    expect(hostedTarget({ OS_BASE_URL: 'http://os/', OS_BOX_TOKEN: 't' } as any)).toEqual({
      baseUrl: 'http://os',
      boxToken: 't',
    });
  });
});

describe('checkHostedUpdate', () => {
  it('asks OS what image is built, carrying the box token', async () => {
    const f = fakeFetch(() => ({ ok: true, json: async () => ({ available: true, version: '2.28.0' }) }));
    const out = await checkHostedUpdate(TARGET, '2.27.0', { fetchImpl: f });
    expect(out).toMatchObject({ available: true, version: '2.28.0', currentVersion: '2.27.0' });
    const [url, init] = (f as any).mock.calls[0];
    expect(String(url)).toContain('/api/dispatch/box/update?current=2.27.0');
    expect((init.headers as any)['x-dispatch-box-token']).toBe('box-secret');
  });

  it('reports an unreachable control plane instead of claiming "no update"', async () => {
    const f = fakeFetch(() => { throw new Error('ECONNREFUSED'); });
    const out = await checkHostedUpdate(TARGET, '2.27.0', { fetchImpl: f });
    expect(out.available).toBe(false);
    // The distinction matters: silently reporting "up to date" turns an outage
    // into a user who never updates and never knows why.
    expect(out.error).toContain('could not reach OS');
  });

  it('reports a non-200 as an error, not as an answer', async () => {
    const f = fakeFetch(() => ({ ok: false, status: 401, json: async () => ({}) }));
    const out = await checkHostedUpdate(TARGET, '2.27.0', { fetchImpl: f });
    expect(out.available).toBe(false);
    expect(out.error).toContain('401');
  });
});

describe('applyHostedUpdate', () => {
  it('asks OS to roll the box onto the newest image', async () => {
    const f = fakeFetch(() => ({ ok: true, json: async () => ({ ok: true }) }));
    const out = await applyHostedUpdate(TARGET, { fetchImpl: f });
    expect(out.ok).toBe(true);
    const [url, init] = (f as any).mock.calls[0];
    expect(String(url)).toBe('http://os.internal/api/dispatch/box/rebuild');
    expect(init.method).toBe('POST');
  });

  it("surfaces OS's own reason so the user can act on it", async () => {
    const f = fakeFetch(() => ({
      ok: false,
      status: 409,
      json: async () => ({ detail: 'already running the newest image' }),
    }));
    const out = await applyHostedUpdate(TARGET, { fetchImpl: f });
    expect(out).toEqual({ ok: false, reason: 'already running the newest image' });
  });

  it('falls back to the status when the error body is not JSON', async () => {
    const f = fakeFetch(() => ({
      ok: false,
      status: 502,
      json: async () => { throw new Error('not json'); },
    }));
    const out = await applyHostedUpdate(TARGET, { fetchImpl: f });
    expect(out.ok).toBe(false);
    expect(out.reason).toContain('502');
  });

  it('does not hang forever on a stalled control plane', async () => {
    const f = fakeFetch((_url, init) => {
      // Mirror what fetch does with an aborted signal.
      const signal = (init as any).signal as AbortSignal;
      throw Object.assign(new Error(signal ? 'The operation was aborted' : 'no signal'), { name: 'AbortError' });
    });
    const out = await applyHostedUpdate(TARGET, { fetchImpl: f, timeoutMs: 1 });
    expect(out.ok).toBe(false);
    expect(out.reason).toContain('could not reach OS');
  });
});
