import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import worker from '../src/index';
import { validatePing } from '../src/validate';

/** A D1-shaped wrapper over better-sqlite3, enough for this Worker. */
function d1(db: Database.Database) {
  return { prepare: (sql: string) => ({ bind: (...v: unknown[]) => ({
    run: async () => db.prepare(sql).run(...v),
    all: async <T>() => ({ results: db.prepare(sql).all(...v) as T[] }),
  }) }) };
}

const NOW = new Date();
const today = NOW.toISOString().slice(0, 10);
const ping = (over: Record<string, unknown> = {}) => ({
  v: 1, installId: '0b8f3a2e-1c4d-4e5f-9a6b-7c8d9e0f1a2b', version: '3.0.0', platform: 'darwin',
  days: [{ day: today, providers: { claude: { turns: 3, input: 30, output: 12, cacheRead: 5, cacheWrite: 1 } }, threads: 2, chatTurns: 1 }],
  projects: 4, ...over,
});

let db: Database.Database;
let env: { DB: ReturnType<typeof d1> };
beforeEach(() => { db = new Database(':memory:'); db.exec(fs.readFileSync(new URL('../schema.sql', import.meta.url), 'utf8')); env = { DB: d1(db) }; });
const post = (body: unknown, raw?: string) => worker.fetch(new Request('https://dispatchd.app/v1/ping', { method: 'POST', body: raw ?? JSON.stringify(body) }), env as never);

describe('validatePing', () => {
  it('accepts a good ping', () => { expect(validatePing(ping(), NOW).ok).toBe(true); });
  it.each([
    ['wrong v', { v: 2 }],
    ['non-uuid id', { installId: 'david@example.com' }],
    ['non-semver version', { version: 'latest; DROP TABLE' }],
    ['unknown platform', { platform: 'win32' }],
    ['three days', { days: [1, 2, 3].map(() => ping().days[0]) }],
    ['old day', { days: [{ ...ping().days[0], day: '2020-01-01' }] }],
    ['unknown provider key', { days: [{ ...ping().days[0], providers: { 'secret-project': { turns: 1, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } }] }],
    ['negative number', { projects: -1 }],
    ['float', { projects: 1.5 }],
    ['extra text field', { hostname: 'davids-mac' }],
  ])('rejects %s', (_n, over) => { expect(validatePing(ping(over), NOW).ok).toBe(false); });
});

describe('worker', () => {
  it('204 on a good ping; a second ping the same day replaces the row', async () => {
    expect((await post(ping())).status).toBe(204);
    expect((await post(ping({ projects: 9 }))).status).toBe(204);
    const rows = db.prepare('SELECT * FROM pings').all() as { projects: number }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].projects).toBe(9);
  });

  it('400, never 500, on garbage', async () => {
    expect((await post(null, '{not json')).status).toBe(400);
    expect((await post([1, 2])).status).toBe(400);
    expect((await post(null, 'x'.repeat(5000))).status).toBe(400);
  });

  it('404 for other paths and methods', async () => {
    expect((await worker.fetch(new Request('https://dispatchd.app/'), env as never)).status).toBe(404);
    expect((await worker.fetch(new Request('https://dispatchd.app/v1/ping'), env as never)).status).toBe(404);
  });

  it('/stats.json counts daily installs, versions, providers; /stats renders HTML with no external script', async () => {
    await post(ping());
    await post(ping({ installId: '1b8f3a2e-1c4d-4e5f-9a6b-7c8d9e0f1a2b', version: '2.47.9', platform: 'wsl' }));
    const s = await (await worker.fetch(new Request('https://dispatchd.app/stats.json'), env as never)).json() as any;
    expect(s.daily.find((d: any) => d.day === today).installs).toBe(2);
    expect(s.versions).toEqual(expect.arrayContaining([{ version: '3.0.0', installs: 1 }, { version: '2.47.9', installs: 1 }]));
    expect(s.platforms).toEqual(expect.arrayContaining([{ platform: 'darwin', installs: 1 }, { platform: 'wsl', installs: 1 }]));
    expect(s.providers.find((p: any) => p.day === today && p.provider === 'claude')).toMatchObject({ turns: 6, output: 24 });
    const html = await (await worker.fetch(new Request('https://dispatchd.app/stats'), env as never)).text();
    expect(html).toContain('<title>Dispatch stats</title>');
    expect(html).not.toMatch(/<script[^>]+src=/);
  });
});
