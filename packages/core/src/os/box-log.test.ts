import { afterEach, describe, expect, test, vi } from 'vitest';
import { boxLog, setBoxLogForTest } from './box-log.js';
import { OsConnectionsProvider } from '../integrations/os-provider.js';

afterEach(() => setBoxLogForTest());

describe('the hosted box log', () => {
  test('one JSON line per event; string fields are redacted, nested ones too', () => {
    const lines: string[] = [];
    setBoxLogForTest({ enabled: true, sink: (l) => lines.push(l) });
    boxLog('daemon.start', { version: '4.6.0', capabilities: ['base-path'], nested: { why: 'token=sk-ant-oat01-AbCdEfGhIjKlMnOpQrSt' } });
    expect(lines).toHaveLength(1);
    const e = JSON.parse(lines[0]);
    expect(e).toMatchObject({ event: 'daemon.start', version: '4.6.0', capabilities: ['base-path'], src: 'dispatch', level: 'info' });
    expect(lines[0]).not.toContain('AbCdEfGhIjKlMnOpQrSt');
  });

  test('a thread id is kept (the warning must name its thread); a UUID in another field is still redacted', () => {
    const lines: string[] = [];
    setBoxLogForTest({ enabled: true, sink: (l) => lines.push(l) });
    const id = '65302fe6-adf0-4c6c-abd9-c0a89e0c5fc0';
    boxLog('thread.mcp.unexpected', { thread: id, note: `key ${id}`, thread2: { thread: 'token=sk-ant-oat01-AbCdEfGhIjKlMnOpQrSt' } });
    const e = JSON.parse(lines[0]);
    expect(e.thread).toBe(id);
    expect(e.note).not.toContain(id);
    expect(lines[0]).not.toContain('AbCdEfGhIjKlMnOpQrSt');
  });

  test('a sink that throws never breaks the caller', () => {
    setBoxLogForTest({ enabled: true, sink: () => { throw new Error('closed'); } });
    expect(() => boxLog('x')).not.toThrow();
  });

  test('the OS connections fetch: reachable and counts, one line per change, never the env or a token', async () => {
    const lines: string[] = [];
    setBoxLogForTest({ enabled: true, sink: (l) => lines.push(l) });
    const ok = { servers: [{ name: 'a', command: 'x', args: [] }], env: { SOME_TOKEN: 'short-lived-secret-value' }, needsConsent: [{ system: 's', label: 'S', connectUrl: '/c' }], profile: 'business' };
    let fail = false;
    const f = vi.fn(async () => (fail ? { ok: false, status: 502, json: async () => ({}) } : { ok: true, status: 200, json: async () => ok }));
    const p = new OsConnectionsProvider({ baseUrl: 'https://os.example', boxToken: 'tok', fetchImpl: f as any, retryMinMs: 60_000 });
    await p.refresh();
    await p.refresh(); // the same answer: no second line
    fail = true;
    await p.refresh();
    p.stop();
    const e = lines.map((l) => JSON.parse(l));
    expect(e).toHaveLength(2);
    expect(e[0]).toMatchObject({ event: 'os.connections', reachable: true, servers: 1, needsConsent: 1, profile: 'business' });
    expect(e[1]).toMatchObject({ event: 'os.connections', reachable: false, status: 502, level: 'warn' });
    expect(lines.join('\n')).not.toContain('short-lived-secret-value');
    expect(lines.join('\n')).not.toContain('tok"');
  });
});
