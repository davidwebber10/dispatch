import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import { getInstallId } from '../../src/telemetry/install-id.js';
import { buildReport, utcDay } from '../../src/telemetry/payload.js';

function db() { const d = new Database(':memory:'); initSchema(d); return d; }
let n = 0;
function turn(d: Database.Database, provider: string, startedAt: string, terminal = 't1', tok = { i: 10, o: 5, cr: 2, cw: 1 }) {
  d.prepare(`INSERT INTO usage_turns (id, terminal_id, project_id, provider, model, started_at, input_tokens, output_tokens, cache_read_tokens, cache_create_tokens)
             VALUES (?, ?, 'p-secret-project', ?, 'claude-opus-secret', ?, ?, ?, ?, ?)`).run(`u${++n}`, terminal, provider, startedAt, tok.i, tok.o, tok.cr, tok.cw);
}

describe('telemetry install id', () => {
  it('is a v4 uuid, made once and then stable', () => {
    const d = db();
    const a = getInstallId(d);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(getInstallId(d)).toBe(a);
  });
});

describe('telemetry report', () => {
  const now = new Date('2026-10-15T15:00:00Z');

  it('sums today per provider; counts threads, chat user messages and projects', () => {
    const d = db();
    turn(d, 'claude', '2026-10-15T01:00:00.000Z', 't1');
    turn(d, 'claude', '2026-10-15T02:00:00.000Z', 't2');
    turn(d, 'codex', '2026-10-15T03:00:00.000Z', 't2');
    turn(d, 'claude', '2026-10-14T23:59:59.000Z', 't9'); // yesterday: not in today
    d.prepare("INSERT INTO endless_messages (i, kind, text, size, created_at) VALUES (0, 'user', 'private words', 13, ?)").run(Date.parse('2026-10-15T04:00:00Z'));
    d.prepare("INSERT INTO endless_messages (i, kind, text, size, created_at) VALUES (1, 'unii', 'reply', 5, ?)").run(Date.parse('2026-10-15T04:00:01Z'));
    const r = buildReport(d, { now, version: '3.0.0', platform: 'darwin', includeYesterday: false });
    expect(r.days).toHaveLength(1);
    expect(r.days[0]).toEqual({
      day: '2026-10-15',
      providers: { claude: { turns: 2, input: 20, output: 10, cacheRead: 4, cacheWrite: 2 }, codex: { turns: 1, input: 10, output: 5, cacheRead: 2, cacheWrite: 1 } },
      threads: 2,
      chatTurns: 1,
    });
    expect(r).toMatchObject({ v: 1, version: '3.0.0', platform: 'darwin' });
    expect(typeof r.projects).toBe('number');
  });

  it('includes yesterday only when asked (the install was alive yesterday)', () => {
    const d = db();
    turn(d, 'claude', '2026-10-14T10:00:00.000Z');
    expect(buildReport(d, { now, version: '3.0.0', platform: 'darwin', includeYesterday: false }).days.map((x) => x.day)).toEqual(['2026-10-15']);
    expect(buildReport(d, { now, version: '3.0.0', platform: 'darwin', includeYesterday: true }).days.map((x) => x.day)).toEqual(['2026-10-14', '2026-10-15']);
  });

  it('folds unknown provider values into other and never leaks any stored text', () => {
    const d = db();
    turn(d, 'claude-code', '2026-10-15T01:00:00.000Z');
    turn(d, 'my-secret-harness', '2026-10-15T01:00:00.000Z');
    const r = buildReport(d, { now, version: '3.0.0', platform: 'wsl', includeYesterday: false });
    expect(Object.keys(r.days[0].providers).sort()).toEqual(['claude', 'other']);
    const json = JSON.stringify(r);
    for (const leak of ['secret', 'private', 'p-secret-project', 'opus', 't1']) expect(json).not.toContain(leak);
    expect(Buffer.byteLength(json)).toBeLessThan(4096);
  });

  it('utcDay uses the UTC date', () => {
    expect(utcDay(new Date('2026-10-15T23:30:00-05:00'))).toBe('2026-10-16');
  });
});
