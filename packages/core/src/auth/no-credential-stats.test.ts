import { describe, expect, test } from 'vitest';
import { createNoCredentialStats, pathPattern } from './no-credential-stats.js';

const req = (method: string, path: string, headers: Record<string, string> = {}) =>
  ({ method, path, headers: { 'user-agent': 'curl/8', ...headers } }) as never;

describe('pathPattern', () => {
  test('replaces uuid and long id segments', () => {
    expect(pathPattern('/api/terminals/3f2b8c1e-9a4d-4e0b-8c55-1a2b3c4d5e6f/ws')).toBe('/api/terminals/:id/ws');
    expect(pathPattern('/api/x/abcdefghij0123456789zz')).toBe('/api/x/:id');
    expect(pathPattern('/api/access/no-credential-stats')).toBe('/api/access/no-credential-stats');
  });
});

describe('a key in the request', () => {
  const key = 'dtk_' + 'AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEfGhIjKlMnOpQ'.slice(0, 43); // no digit
  test('pathPattern hides a key segment, with or without a digit', () => {
    expect(pathPattern(`/api/terminals/${key}/ws`)).toBe('/api/terminals/:id/ws');
    expect(pathPattern(`/api/x/dck_${'a1'.repeat(21)}b`)).toBe('/api/x/:id');
  });
  test('no log line or count holds a key from the path or the user agent', () => {
    const lines: string[] = [];
    let t = 0;
    const s = createNoCredentialStats({ log: (l) => lines.push(l), now: () => t });
    s.record(req('GET', `/api/terminals/${key}`, { 'user-agent': `curl ${key}` }));
    t += 61 * 60_000;
    s.record(req('GET', `/api/other/${key}`));
    expect(lines.join('\n')).not.toContain(key);
    expect(JSON.stringify(s.snapshot())).not.toContain(key);
  });
});

describe('createNoCredentialStats', () => {
  test('counts per category and pattern, logs first sight only', () => {
    let t = 0;
    const lines: string[] = [];
    const s = createNoCredentialStats({ log: (l) => lines.push(l), now: () => t });
    s.record(req('GET', '/api/roles'));
    s.record(req('GET', '/api/roles'));
    s.record(req('GET', '/api/roles', { 'sec-fetch-mode': 'cors' }));
    const snap = s.snapshot();
    expect(snap.program.top).toEqual([{ pattern: 'GET /api/roles', count: 2 }]);
    expect(snap.browser.total).toBe(1);
    expect(typeof snap.since).toBe('number');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe('[keys] no-credential program GET /api/roles UA=curl/8');
  });
});
