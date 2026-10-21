# Anonymous Usage Telemetry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Each Dispatch install sends an anonymous daily usage report to `dispatchd.app`, and the owner reads the totals on an Access-protected `/stats` page.

**Architecture:** The daemon builds a small report from its local SQLite (`usage_turns`, `endless_messages`, `sessions`) and POSTs it on an hourly check (at most every 6 h, plus the first check of a new UTC day). A Cloudflare Worker with D1 upserts one row per install per UTC day and renders `/stats`. Cloudflare Access (set up by hand, already done) guards `/stats*`.

**Tech Stack:** TypeScript, Node 23, better-sqlite3, Express, React 18, vitest; Cloudflare Workers + D1, wrangler 4.151.0.

**Spec:** `docs/superpowers/specs/2026-10-15-telemetry-design.md`

## Global Constraints

- On by default; app_state key `telemetry_enabled` absent or `'1'` = on, `'0'` = off.
- `DISPATCH_TELEMETRY=0` in the daemon env disables all sends, whatever the setting.
- `DISPATCH_TELEMETRY_URL` overrides the endpoint (default `https://dispatchd.app/v1/ping`).
- No text in the report other than `installId`, `version`, `platform`, `day`, provider keys.
- Provider keys: `claude`, `codex`, `opencode`, `grok`, `other` (anything else folds into `other`).
- Report body at most 4096 bytes; fetch timeout 5000 ms; a failed send never throws.
- The setting row is the LAST row of Settings → General, label exactly `Send anonymous usage stats`.
- Release notes, README, and docs never mention telemetry. Code and label stay plain.
- Core imports use explicit `.js` extensions (ESM; the daemon will not start otherwise).
- Git: never `git stash`, `reset`, `checkout <branch>`, `switch`, or `push`. Commit on `feat/endless-chat` only.
- Never start a second daemon on the real `~/.dispatch`. Never `pkill` node.

## Review Focus

1. An install that was off all of yesterday must not send a row for yesterday (inflated DAU) — test in Task 1.
2. A `usage_turns.provider` value such as `claude-code` or an unknown harness must fold to a known key, never leak as free text — test in Task 1.
3. A clock skewed day or a replayed old report must be rejected by the Worker (day more than 2 days from server UTC) — test in Task 4.
4. Turning the toggle off must stop the very next check from sending, without a restart — test in Task 2.
5. The Worker must never return 500 on garbage input (invalid JSON, huge body, arrays) — test in Task 4.

---

### Task 1: Install ID and report builder

**Files:**
- Create: `packages/core/src/telemetry/install-id.ts`
- Create: `packages/core/src/telemetry/payload.ts`
- Test: `packages/core/tests/telemetry/payload.test.ts`

**Interfaces:**
- Produces: `getInstallId(db): string`; `type TelemetryReport`; `type DayTotals`; `buildReport(db, opts: { now: Date; version: string; platform: 'darwin' | 'wsl' | 'linux'; includeYesterday: boolean }): TelemetryReport`; `utcDay(d: Date): string`; `PROVIDER_KEYS`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/tests/telemetry/payload.test.ts
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
```

- [ ] **Step 2: Run it and see it fail**

Run: `cd packages/core && npx vitest run tests/telemetry/payload.test.ts`
Expected: FAIL — cannot find module `../../src/telemetry/install-id.js`.

- [ ] **Step 3: Implement**

```ts
// packages/core/src/telemetry/install-id.ts
import { randomUUID } from 'crypto';
import type Database from 'better-sqlite3';
import * as appState from '../db/app-state.js';

/** A random id made once per install. It is not derived from the machine, the user, or any account. */
export function getInstallId(db: Database.Database): string {
  const have = appState.get(db, 'telemetry_install_id');
  if (have) return have;
  const id = randomUUID();
  appState.set(db, 'telemetry_install_id', id);
  return id;
}
```

```ts
// packages/core/src/telemetry/payload.ts
import type Database from 'better-sqlite3';
import { getInstallId } from './install-id.js';

export const PROVIDER_KEYS = ['claude', 'codex', 'opencode', 'grok', 'other'] as const;
export type ProviderKey = (typeof PROVIDER_KEYS)[number];
export interface ProviderTotals { turns: number; input: number; output: number; cacheRead: number; cacheWrite: number }
export interface DayTotals { day: string; providers: Partial<Record<ProviderKey, ProviderTotals>>; threads: number; chatTurns: number }
export interface TelemetryReport { v: 1; installId: string; version: string; platform: 'darwin' | 'wsl' | 'linux'; days: DayTotals[]; projects: number }

export const utcDay = (d: Date): string => d.toISOString().slice(0, 10);

/** `claude-code` → `claude`; anything unknown → `other`. Free text never leaves the machine. */
function providerKey(raw: string): ProviderKey {
  const p = raw.toLowerCase();
  if (p.startsWith('claude')) return 'claude';
  if (p.startsWith('codex')) return 'codex';
  if (p.startsWith('opencode')) return 'opencode';
  if (p.startsWith('grok')) return 'grok';
  return 'other';
}

function dayTotals(db: Database.Database, day: string): DayTotals {
  const from = `${day}T00:00:00.000Z`;
  const next = new Date(Date.parse(from) + 86_400_000).toISOString();
  const rows = db.prepare(`
    SELECT provider, COUNT(*) AS turns, SUM(input_tokens) AS input, SUM(output_tokens) AS output,
           SUM(cache_read_tokens) AS cacheRead, SUM(cache_create_tokens) AS cacheWrite
    FROM usage_turns WHERE started_at >= ? AND started_at < ? GROUP BY provider`).all(from, next) as
    { provider: string; turns: number; input: number; output: number; cacheRead: number; cacheWrite: number }[];
  const providers: DayTotals['providers'] = {};
  for (const r of rows) {
    const k = providerKey(r.provider);
    const t = providers[k] ?? { turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    t.turns += r.turns; t.input += r.input ?? 0; t.output += r.output ?? 0; t.cacheRead += r.cacheRead ?? 0; t.cacheWrite += r.cacheWrite ?? 0;
    providers[k] = t;
  }
  const threads = (db.prepare('SELECT COUNT(DISTINCT terminal_id) AS n FROM usage_turns WHERE started_at >= ? AND started_at < ?').get(from, next) as { n: number }).n;
  const chatTurns = (db.prepare("SELECT COUNT(*) AS n FROM endless_messages WHERE kind = 'user' AND created_at >= ? AND created_at < ?")
    .get(Date.parse(from), Date.parse(next)) as { n: number }).n;
  return { day, providers, threads, chatTurns };
}

export function buildReport(db: Database.Database, o: { now: Date; version: string; platform: TelemetryReport['platform']; includeYesterday: boolean }): TelemetryReport {
  const today = utcDay(o.now);
  const days = [today];
  if (o.includeYesterday) days.unshift(utcDay(new Date(o.now.getTime() - 86_400_000)));
  const projects = (db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n;
  return { v: 1, installId: getInstallId(db), version: o.version, platform: o.platform, days: days.map((d) => dayTotals(db, d)), projects };
}
```

Note for the implementer: a multi-row `endless_messages` text (a long message split into several `user` rows) counts once per row. That is acceptable at this level; do not try to merge rows.

- [ ] **Step 4: Run the test and see it pass**

Run: `cd packages/core && npx vitest run tests/telemetry/payload.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/telemetry packages/core/tests/telemetry
git commit -m "feat(telemetry): install id and anonymous daily report builder"
```

---

### Task 2: Sender loop, setting route, daemon wiring

**Files:**
- Create: `packages/core/src/telemetry/sender.ts`
- Create: `packages/core/src/routes/telemetry-settings.ts`
- Modify: `packages/core/src/server.ts` (both route-mount blocks near lines 377 and 700; the loop next to `startUpdateCheckLoop` near line 888; `clearInterval` in `cleanup`)
- Test: `packages/core/tests/telemetry/sender.test.ts`, `packages/core/tests/routes/telemetry-settings.test.ts`

**Interfaces:**
- Consumes: `buildReport`, `utcDay`, `TelemetryReport` (Task 1); `getRunningVersion()` from `../update/version.js`; `appState.get/set` from `../db/app-state.js`.
- Produces: `telemetryEnabled(db, env?): boolean`; `setTelemetryEnabled(db, on: boolean): void`; `checkTelemetryOnce(db, deps?): Promise<'sent' | 'skipped' | 'disabled' | 'failed'>`; `startTelemetryLoop(db, deps?): { stop(): void }`; HTTP `GET /api/settings/telemetry` → `{ enabled: boolean }`, `PUT /api/settings/telemetry` body `{ enabled: boolean }` → `{ enabled: boolean }`.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/core/tests/telemetry/sender.test.ts
import { describe, it, expect, vi } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import { checkTelemetryOnce, setTelemetryEnabled, telemetryEnabled, startTelemetryLoop } from '../../src/telemetry/sender.js';

function setup() {
  const db = new Database(':memory:'); initSchema(db);
  const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
  let now = new Date('2026-10-15T10:00:00Z');
  const deps = { fetchImpl: fetchImpl as unknown as typeof fetch, now: () => now, env: {} as NodeJS.ProcessEnv, version: '3.0.0', platform: 'darwin' as const, url: 'https://example.test/v1/ping' };
  return { db, fetchImpl, deps, setNow: (d: string) => { now = new Date(d); } };
}
const body = (f: ReturnType<typeof vi.fn>, k = -1) => JSON.parse((f.mock.calls.at(k)![1] as RequestInit).body as string);

describe('telemetry sender', () => {
  it('is on by default; the setting and DISPATCH_TELEMETRY=0 turn it off', () => {
    const { db } = setup();
    expect(telemetryEnabled(db, {})).toBe(true);
    expect(telemetryEnabled(db, { DISPATCH_TELEMETRY: '0' })).toBe(false);
    setTelemetryEnabled(db, false);
    expect(telemetryEnabled(db, {})).toBe(false);
  });

  it('sends on the first check, skips within 6 h, sends again after 6 h', async () => {
    const t = setup();
    expect(await checkTelemetryOnce(t.db, t.deps)).toBe('sent');
    expect(t.fetchImpl).toHaveBeenCalledTimes(1);
    expect(t.fetchImpl.mock.calls[0][0]).toBe('https://example.test/v1/ping');
    t.setNow('2026-10-15T15:59:00Z');
    expect(await checkTelemetryOnce(t.db, t.deps)).toBe('skipped');
    t.setNow('2026-10-15T16:01:00Z');
    expect(await checkTelemetryOnce(t.db, t.deps)).toBe('sent');
  });

  it('the first check of a new UTC day sends at once and carries yesterday; a gap day carries no yesterday', async () => {
    const t = setup();
    t.setNow('2026-10-15T22:00:00Z');
    await checkTelemetryOnce(t.db, t.deps);
    t.setNow('2026-10-16T00:30:00Z');
    expect(await checkTelemetryOnce(t.db, t.deps)).toBe('sent');
    expect(body(t.fetchImpl).days.map((d: { day: string }) => d.day)).toEqual(['2026-10-15', '2026-10-16']);
    t.setNow('2026-10-18T09:00:00Z'); // off all of 10-17
    await checkTelemetryOnce(t.db, t.deps);
    expect(body(t.fetchImpl).days.map((d: { day: string }) => d.day)).toEqual(['2026-10-18']);
  });

  it('makes no request when off (setting or env), and the next check obeys a fresh toggle', async () => {
    const t = setup();
    setTelemetryEnabled(t.db, false);
    expect(await checkTelemetryOnce(t.db, t.deps)).toBe('disabled');
    expect(await checkTelemetryOnce(t.db, { ...t.deps, env: { DISPATCH_TELEMETRY: '0' } })).toBe('disabled');
    expect(t.fetchImpl).not.toHaveBeenCalled();
    setTelemetryEnabled(t.db, true);
    expect(await checkTelemetryOnce(t.db, t.deps)).toBe('sent');
  });

  it('a failing or throwing fetch returns failed, never throws, and retries on the next check', async () => {
    const t = setup();
    t.fetchImpl.mockRejectedValueOnce(new Error('offline'));
    expect(await checkTelemetryOnce(t.db, t.deps)).toBe('failed');
    t.fetchImpl.mockResolvedValueOnce(new Response(null, { status: 500 }));
    expect(await checkTelemetryOnce(t.db, t.deps)).toBe('failed');
    expect(await checkTelemetryOnce(t.db, t.deps)).toBe('sent');
  });

  it('the loop checks after the boot delay, then every hour, and stops', async () => {
    vi.useFakeTimers();
    try {
      const t = setup();
      const loop = startTelemetryLoop(t.db, { ...t.deps, bootDelayMs: 60_000, intervalMs: 3_600_000 });
      await vi.advanceTimersByTimeAsync(59_000);
      expect(t.fetchImpl).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(t.fetchImpl).toHaveBeenCalledTimes(1);
      loop.stop();
      await vi.advanceTimersByTimeAsync(10 * 3_600_000);
      expect(t.fetchImpl).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });
});
```

```ts
// packages/core/tests/routes/telemetry-settings.test.ts
import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import { createTelemetrySettingsRouter } from '../../src/routes/telemetry-settings.js';

describe('telemetry settings route', () => {
  it('GET is on by default; PUT false turns it off; a bad body is 400', async () => {
    const db = new Database(':memory:'); initSchema(db);
    const app = express(); app.use(express.json()); app.use('/api/settings/telemetry', createTelemetrySettingsRouter(db));
    expect((await request(app).get('/api/settings/telemetry')).body).toEqual({ enabled: true });
    expect((await request(app).put('/api/settings/telemetry').send({ enabled: false })).body).toEqual({ enabled: false });
    expect((await request(app).get('/api/settings/telemetry')).body).toEqual({ enabled: false });
    expect((await request(app).put('/api/settings/telemetry').send({ enabled: 'no' })).status).toBe(400);
  });
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `cd packages/core && npx vitest run tests/telemetry/sender.test.ts tests/routes/telemetry-settings.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

```ts
// packages/core/src/telemetry/sender.ts
import type Database from 'better-sqlite3';
import * as appState from '../db/app-state.js';
import { getRunningVersion } from '../update/version.js';
import { detectWsl } from '../platform/wsl.js';
import { buildReport, utcDay, type TelemetryReport } from './payload.js';

export const TELEMETRY_URL = 'https://dispatchd.app/v1/ping';
const RESEND_MS = 6 * 3_600_000;
const TIMEOUT_MS = 5_000;

export interface TelemetryDeps {
  fetchImpl?: typeof fetch;
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
  version?: string;
  platform?: TelemetryReport['platform'];
  url?: string;
  bootDelayMs?: number;
  intervalMs?: number;
}

export function telemetryEnabled(db: Database.Database, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.DISPATCH_TELEMETRY === '0') return false;
  return appState.get(db, 'telemetry_enabled') !== '0';
}

export function setTelemetryEnabled(db: Database.Database, on: boolean): void {
  appState.set(db, 'telemetry_enabled', on ? '1' : '0');
}

function hostPlatform(): TelemetryReport['platform'] {
  if (process.platform === 'darwin') return 'darwin';
  return detectWsl() ? 'wsl' : 'linux';
}

let warnedDay = '';

/** One check. Never throws. */
export async function checkTelemetryOnce(db: Database.Database, d: TelemetryDeps = {}): Promise<'sent' | 'skipped' | 'disabled' | 'failed'> {
  try {
    const env = d.env ?? process.env;
    if (!telemetryEnabled(db, env)) return 'disabled';
    const now = (d.now ?? (() => new Date()))();
    const today = utcDay(now);
    const yesterday = utcDay(new Date(now.getTime() - 86_400_000));
    const aliveBefore = appState.get(db, 'telemetry_alive_day');
    appState.set(db, 'telemetry_alive_day', today);
    const lastSentAt = Number(appState.get(db, 'telemetry_last_sent_at') ?? 0);
    const lastSentDay = appState.get(db, 'telemetry_last_sent_day');
    const newDay = lastSentDay !== today;
    if (!newDay && now.getTime() - lastSentAt < RESEND_MS) return 'skipped';
    // Yesterday rides along only when this install was alive yesterday and its final totals are not yet sent.
    const includeYesterday = (aliveBefore === yesterday || lastSentDay === yesterday) && newDay;
    const report = buildReport(db, { now, version: d.version ?? getRunningVersion(), platform: d.platform ?? hostPlatform(), includeYesterday });
    const res = await (d.fetchImpl ?? fetch)(d.url ?? env.DISPATCH_TELEMETRY_URL ?? TELEMETRY_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(report),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    appState.set(db, 'telemetry_last_sent_at', String(now.getTime()));
    appState.set(db, 'telemetry_last_sent_day', today);
    return 'sent';
  } catch (err) {
    const day = new Date().toISOString().slice(0, 10);
    if (warnedDay !== day) { warnedDay = day; console.warn('[telemetry] send failed:', err instanceof Error ? err.message : String(err)); }
    return 'failed';
  }
}

export function startTelemetryLoop(db: Database.Database, d: TelemetryDeps = {}): { stop(): void } {
  let interval: NodeJS.Timeout | null = null;
  const boot = setTimeout(() => {
    void checkTelemetryOnce(db, d);
    interval = setInterval(() => { void checkTelemetryOnce(db, d); }, d.intervalMs ?? 3_600_000);
  }, d.bootDelayMs ?? 60_000);
  return { stop: () => { clearTimeout(boot); if (interval) clearInterval(interval); } };
}
```

Check `detectWsl` is exported from `packages/core/src/platform/wsl.ts` (it is imported by `platform/index.ts`); if its signature needs args, call it as `platform/index.ts` does.

Note on `includeYesterday`: the test "a gap day carries no yesterday" requires that after a 10-17 gap the 10-18 report has only today. On 10-18, `aliveBefore` is `2026-10-16` and `lastSentDay` is `2026-10-16`, neither equals yesterday (`2026-10-17`), so yesterday is left out. Keep that logic exactly.

```ts
// packages/core/src/routes/telemetry-settings.ts
import { Router } from 'express';
import type Database from 'better-sqlite3';
import { setTelemetryEnabled, telemetryEnabled } from '../telemetry/sender.js';

/** GET/PUT /api/settings/telemetry — the "Send anonymous usage stats" switch. */
export function createTelemetrySettingsRouter(db: Database.Database): Router {
  const router = Router();
  const view = () => ({ enabled: telemetryEnabled(db, {}) });
  router.get('/', (_req, res) => { res.json(view()); });
  router.put('/', (req, res) => {
    const on = req.body?.enabled;
    if (typeof on !== 'boolean') { res.status(400).json({ error: 'enabled (boolean) is required' }); return; }
    setTelemetryEnabled(db, on);
    res.json(view());
  });
  return router;
}
```

The route reports the user's setting (`env` `{}`), not the env override, so the switch shows what the user chose.

Wiring in `packages/core/src/server.ts`:
1. Imports: `import { createTelemetrySettingsRouter } from './routes/telemetry-settings.js';` and `import { startTelemetryLoop } from './telemetry/sender.js';`
2. In BOTH route blocks, right after the `app.use('/api/settings/harnesses', …)` line: `app.use('/api/settings/telemetry', createTelemetrySettingsRouter(db));`
3. After `const updateCheckInterval = startUpdateCheckLoop(db, broadcaster);` (only in the block that also starts the update loop): `const telemetryLoop = startTelemetryLoop(db);`
4. In `cleanup`, after `clearInterval(updateCheckInterval);`: `telemetryLoop.stop();`

- [ ] **Step 4: Run the tests, the typecheck, and a daemon smoke start**

Run: `cd packages/core && npx vitest run tests/telemetry tests/routes/telemetry-settings.test.ts && npx tsc --noEmit -p .`
Expected: PASS, no type errors.

Then build and smoke-start an isolated daemon (ESM `.js` check), never on the real `~/.dispatch`:

```bash
cd packages/core && pnpm build && cd ../..
SMOKE=$(mktemp -d) && HOME=$SMOKE PORT=3998 DISPATCH_TELEMETRY=0 node packages/core/dist/server.js > $SMOKE/log 2>&1 &
sleep 5; curl -s localhost:3998/api/settings/telemetry; for p in $(lsof -ti :3998); do kill $p; done
```
Expected: `{"enabled":true}`.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/telemetry packages/core/src/routes/telemetry-settings.ts packages/core/src/server.ts packages/core/tests/telemetry packages/core/tests/routes/telemetry-settings.test.ts
git commit -m "feat(telemetry): hourly check sends the anonymous report; GET/PUT /api/settings/telemetry"
```

---

### Task 3: The switch at the bottom of Settings → General

**Files:**
- Modify: `packages/web/src/api/client.ts` (next to `getHarnessSettings`)
- Create: `packages/web/src/components/settings/TelemetrySetting.tsx`
- Modify: `packages/web/src/components/settings/GeneralSection.tsx` (append after `<UpdatesSection />`)
- Modify: `packages/web/src/components/settings/ui.tsx:26` (optional `label` on `Toggle`)
- Test: `packages/web/src/components/settings/TelemetrySetting.test.tsx`

**Interfaces:**
- Consumes: `GET/PUT /api/settings/telemetry` (Task 2); `row`, `item`, `Toggle`, `Divider` from `./ui`.
- Produces: `api.getTelemetrySetting(): Promise<{ enabled: boolean }>`, `api.setTelemetrySetting(enabled: boolean): Promise<{ enabled: boolean }>`, `<TelemetrySetting />`.

- [ ] **Step 1: Write the failing test**

```tsx
// packages/web/src/components/settings/TelemetrySetting.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { TelemetrySetting } from './TelemetrySetting';
import { GeneralSection } from './GeneralSection';
import { api } from '../../api/client';

beforeEach(() => { vi.restoreAllMocks(); });

describe('TelemetrySetting', () => {
  it('shows the saved state and flips it through the API', async () => {
    vi.spyOn(api, 'getTelemetrySetting').mockResolvedValue({ enabled: true });
    const put = vi.spyOn(api, 'setTelemetrySetting').mockResolvedValue({ enabled: false });
    render(<TelemetrySetting />);
    const sw = await screen.findByRole('switch', { name: 'Send anonymous usage stats' });
    await waitFor(() => expect(sw).toHaveAttribute('aria-checked', 'true'));
    fireEvent.click(sw);
    await waitFor(() => expect(put).toHaveBeenCalledWith(false));
    await waitFor(() => expect(sw).toHaveAttribute('aria-checked', 'false'));
  });

  it('is the last row of General', async () => {
    vi.spyOn(api, 'getTelemetrySetting').mockResolvedValue({ enabled: true });
    const { container } = render(<GeneralSection />);
    await screen.findByText('Send anonymous usage stats');
    expect(container.textContent!.trimEnd().endsWith('Send anonymous usage stats')).toBe(true);
  });
});
```

`Toggle` (`ui.tsx:26-32`) is a bare `<button>` with no role or name. Give it an optional `label` prop, so existing callers do not change:

```tsx
// packages/web/src/components/settings/ui.tsx
export function Toggle({ on, onClick, label }: { on: boolean; onClick: () => void; label?: string }) {
  return (
    <button onClick={onClick} {...(label ? { role: 'switch', 'aria-checked': on, 'aria-label': label } : {})} style={/* unchanged */}>
```

Keep the existing `style` and inner `<span>` exactly as they are.

- [ ] **Step 2: Run it and see it fail**

Run: `cd packages/web && npx vitest run src/components/settings/TelemetrySetting.test.tsx`
Expected: FAIL — `./TelemetrySetting` not found.

- [ ] **Step 3: Implement**

```ts
// packages/web/src/api/client.ts — add next to getHarnessSettings
  getTelemetrySetting: () => req<{ enabled: boolean }>('/api/settings/telemetry'),
  setTelemetrySetting: (enabled: boolean) => req<{ enabled: boolean }>('/api/settings/telemetry', { method: 'PUT', body: body({ enabled }) }),
```

```tsx
// packages/web/src/components/settings/TelemetrySetting.tsx
import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import { row, item, Toggle } from './ui';

/** The last row of General: the anonymous usage stats switch (daemon setting). */
export function TelemetrySetting() {
  const [on, setOn] = useState<boolean | null>(null);
  useEffect(() => { api.getTelemetrySetting().then((s) => setOn(s.enabled)).catch(() => setOn(null)); }, []);
  const flip = () => {
    if (on === null) return;
    const next = !on;
    setOn(next);
    api.setTelemetrySetting(next).then((s) => setOn(s.enabled)).catch(() => setOn(!next));
  };
  if (on === null) return null;
  return (
    <div style={row}>
      <span style={item}>Send anonymous usage stats</span>
      <Toggle on={on} onClick={flip} label="Send anonymous usage stats" />
    </div>
  );
}
```

In `GeneralSection.tsx`, import `TelemetrySetting` and append after `<UpdatesSection />`:

```tsx
      <UpdatesSection />
      <Divider />
      <TelemetrySetting />
```

- [ ] **Step 4: Run the tests and the typecheck**

Run: `cd packages/web && npx vitest run src/components/settings && npx tsc --noEmit -p .`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/api/client.ts packages/web/src/components/settings/ui.tsx packages/web/src/components/settings/TelemetrySetting.tsx packages/web/src/components/settings/TelemetrySetting.test.tsx packages/web/src/components/settings/GeneralSection.tsx
git commit -m "feat(settings): Send anonymous usage stats switch at the bottom of General"
```

---

### Task 4: The Worker (ping intake + /stats)

**Files:**
- Create: `services/telemetry/package.json`, `services/telemetry/tsconfig.json`, `services/telemetry/wrangler.toml`, `services/telemetry/schema.sql`
- Create: `services/telemetry/src/validate.ts`, `services/telemetry/src/stats.ts`, `services/telemetry/src/index.ts`
- Test: `services/telemetry/test/worker.test.ts`

`services/` is NOT in `pnpm-workspace.yaml` (`packages/*` only), so this package has its own `npm install` and never runs in the daemon build.

**Interfaces:**
- Consumes: the `TelemetryReport` JSON shape from Task 1 (copied as a type, not imported).
- Produces: `validatePing(body: unknown, now: Date): { ok: true; ping: Ping } | { ok: false; error: string }`; `computeStats(db: D1Like, now: Date): Promise<Stats>`; `renderStats(s: Stats): string`; default export `{ fetch(req, env) }`; `interface D1Like { prepare(sql: string): { bind(...v: unknown[]): { run(): Promise<unknown>; all<T>(): Promise<{ results: T[] }> } } }`.

- [ ] **Step 1: Scaffold**

```json
// services/telemetry/package.json
{
  "name": "dispatch-telemetry",
  "private": true,
  "type": "module",
  "scripts": { "test": "vitest run", "deploy": "wrangler deploy" },
  "devDependencies": { "@cloudflare/workers-types": "4.20251001.0", "better-sqlite3": "11.10.0", "typescript": "5.6.3", "vitest": "2.1.9", "wrangler": "4.151.0" }
}
```

```json
// services/telemetry/tsconfig.json
{ "compilerOptions": { "target": "ES2022", "module": "ES2022", "moduleResolution": "Bundler", "strict": true, "types": ["@cloudflare/workers-types"], "noEmit": true, "skipLibCheck": true }, "include": ["src", "test"] }
```

```toml
# services/telemetry/wrangler.toml
name = "dispatch-telemetry"
main = "src/index.ts"
compatibility_date = "2026-10-01"
account_id = "d02ecc2fed211574398816b35aa68880"
workers_dev = false
routes = [{ pattern = "dispatchd.app/*", zone_name = "dispatchd.app" }]

[[d1_databases]]
binding = "DB"
database_name = "dispatch-telemetry"
database_id = "REPLACED_IN_TASK_5"
```

(`database_id` is the one value that only exists after `wrangler d1 create` in Task 5; Task 5 Step 1 writes it.)

```sql
-- services/telemetry/schema.sql
CREATE TABLE IF NOT EXISTS pings (
  install_id TEXT NOT NULL,
  day        TEXT NOT NULL,
  version    TEXT NOT NULL,
  platform   TEXT NOT NULL,
  providers  TEXT NOT NULL,
  threads    INTEGER NOT NULL,
  chat_turns INTEGER NOT NULL,
  projects   INTEGER NOT NULL,
  received_at TEXT NOT NULL,
  PRIMARY KEY (install_id, day)
);
CREATE INDEX IF NOT EXISTS idx_pings_day ON pings(day);
```

Run: `cd services/telemetry && npm install` (adds `services/telemetry/package-lock.json`; the root `.gitignore` already ignores `node_modules/`).

- [ ] **Step 2: Write the failing test**

```ts
// services/telemetry/test/worker.test.ts
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
```

- [ ] **Step 3: Run it and see it fail**

Run: `cd services/telemetry && npx vitest run`
Expected: FAIL — `../src/index` not found.

- [ ] **Step 4: Implement**

```ts
// services/telemetry/src/validate.ts
export const PROVIDERS = ['claude', 'codex', 'opencode', 'grok', 'other'] as const;
const PLATFORMS = ['darwin', 'wsl', 'linux'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SEMVER = /^\d{1,4}\.\d{1,4}\.\d{1,6}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const TOP_KEYS = ['v', 'installId', 'version', 'platform', 'days', 'projects'];
const DAY_KEYS = ['day', 'providers', 'threads', 'chatTurns'];
const TOT_KEYS = ['turns', 'input', 'output', 'cacheRead', 'cacheWrite'];

export interface Totals { turns: number; input: number; output: number; cacheRead: number; cacheWrite: number }
export interface PingDay { day: string; providers: Record<string, Totals>; threads: number; chatTurns: number }
export interface Ping { installId: string; version: string; platform: string; days: PingDay[]; projects: number }

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const count = (x: unknown) => Number.isSafeInteger(x) && (x as number) >= 0;
const onlyKeys = (o: Record<string, unknown>, keys: string[]) => Object.keys(o).every((k) => keys.includes(k));

export function validatePing(b: unknown, now: Date): { ok: true; ping: Ping } | { ok: false; error: string } {
  const bad = (error: string) => ({ ok: false as const, error });
  if (!isObj(b) || !onlyKeys(b, TOP_KEYS)) return bad('shape');
  if (b.v !== 1) return bad('v');
  if (typeof b.installId !== 'string' || !UUID.test(b.installId)) return bad('installId');
  if (typeof b.version !== 'string' || !SEMVER.test(b.version)) return bad('version');
  if (typeof b.platform !== 'string' || !PLATFORMS.includes(b.platform)) return bad('platform');
  if (!count(b.projects)) return bad('projects');
  if (!Array.isArray(b.days) || b.days.length < 1 || b.days.length > 2) return bad('days');
  for (const d of b.days) {
    if (!isObj(d) || !onlyKeys(d, DAY_KEYS)) return bad('day shape');
    if (typeof d.day !== 'string' || !DAY.test(d.day)) return bad('day');
    if (Math.abs(Date.parse(`${d.day}T12:00:00Z`) - now.getTime()) > 2.5 * 86_400_000) return bad('day range');
    if (!count(d.threads) || !count(d.chatTurns) || !isObj(d.providers)) return bad('day counts');
    for (const [k, t] of Object.entries(d.providers)) {
      if (!(PROVIDERS as readonly string[]).includes(k)) return bad('provider');
      if (!isObj(t) || !onlyKeys(t, TOT_KEYS) || !TOT_KEYS.every((x) => count(t[x]))) return bad('totals');
    }
  }
  return { ok: true, ping: b as unknown as Ping };
}
```

```ts
// services/telemetry/src/stats.ts
export interface D1Like { prepare(sql: string): { bind(...v: unknown[]): { run(): Promise<unknown>; all<T>(): Promise<{ results: T[] }> } } }
export interface Stats {
  daily: { day: string; installs: number }[];
  versions: { version: string; installs: number }[];
  platforms: { platform: string; installs: number }[];
  providers: { day: string; provider: string; turns: number; output: number }[];
  totals: { installsEver: number; installs7d: number; turns30d: number; output30d: number };
}

const since = (now: Date, days: number) => new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 10);

export async function computeStats(db: D1Like, now: Date): Promise<Stats> {
  const all = async <T>(sql: string, ...v: unknown[]) => (await db.prepare(sql).bind(...v).all<T>()).results;
  const d90 = since(now, 90), d30 = since(now, 30), d7 = since(now, 7);
  const daily = await all<{ day: string; installs: number }>('SELECT day, COUNT(*) AS installs FROM pings WHERE day >= ? GROUP BY day ORDER BY day', d90);
  // Latest version / platform per install over the last 7 days.
  const versions = await all<{ version: string; installs: number }>(
    'SELECT version, COUNT(*) AS installs FROM (SELECT install_id, version FROM pings p WHERE day >= ? AND day = (SELECT MAX(day) FROM pings q WHERE q.install_id = p.install_id)) GROUP BY version ORDER BY installs DESC', d7);
  const platforms = await all<{ platform: string; installs: number }>(
    'SELECT platform, COUNT(DISTINCT install_id) AS installs FROM pings WHERE day >= ? GROUP BY platform ORDER BY installs DESC', d7);
  const providers = await all<{ day: string; provider: string; turns: number; output: number }>(
    `SELECT p.day AS day, j.key AS provider, SUM(json_extract(j.value, '$.turns')) AS turns, SUM(json_extract(j.value, '$.output')) AS output
     FROM pings p, json_each(p.providers) j WHERE p.day >= ? GROUP BY p.day, j.key ORDER BY p.day, j.key`, d30);
  const [t] = await all<{ installsEver: number; installs7d: number }>(
    'SELECT COUNT(DISTINCT install_id) AS installsEver, COUNT(DISTINCT CASE WHEN day >= ? THEN install_id END) AS installs7d FROM pings', d7);
  const turns30d = providers.reduce((n, p) => n + p.turns, 0);
  const output30d = providers.reduce((n, p) => n + p.output, 0);
  return { daily, versions, platforms, providers, totals: { installsEver: t?.installsEver ?? 0, installs7d: t?.installs7d ?? 0, turns30d, output30d } };
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const fmt = (n: number) => n.toLocaleString('en-US');

function bars(rows: { label: string; value: number }[]): string {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return rows.map((r) => `<div class="bar"><span class="l">${esc(r.label)}</span><span class="b" style="width:${(r.value / max) * 100}%"></span><span class="v">${fmt(r.value)}</span></div>`).join('');
}

export function renderStats(s: Stats): string {
  const byDayProvider = new Map<string, number>();
  for (const p of s.providers) byDayProvider.set(p.provider, (byDayProvider.get(p.provider) ?? 0) + p.output);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Dispatch stats</title><style>
:root{--bg:#fafaf9;--fg:#1c1c1e;--mute:#6b6b70;--line:#e5e5e3;--bar:#2f9e5a}
@media (prefers-color-scheme:dark){:root{--bg:#111113;--fg:#ececee;--mute:#8b8b92;--line:#26262b;--bar:#3ecf72}}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 -apple-system,system-ui,sans-serif}
main{max-width:880px;margin:0 auto;padding:24px 16px}h1{font-size:20px;margin:0 0 16px}h2{font-size:13px;color:var(--mute);text-transform:uppercase;letter-spacing:.06em;margin:28px 0 8px}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}.kpi{border:1px solid var(--line);border-radius:10px;padding:12px}.kpi b{display:block;font-size:22px}.kpi span{color:var(--mute);font-size:12px}
.bar{display:grid;grid-template-columns:110px 1fr 90px;align-items:center;gap:8px;margin:3px 0}.bar .b{height:10px;background:var(--bar);border-radius:3px;min-width:2px}.bar .l,.bar .v{font-variant-numeric:tabular-nums;font-size:12.5px}.bar .v{text-align:right;color:var(--mute)}
</style></head><body><main><h1>Dispatch stats</h1>
<div class="kpis"><div class="kpi"><b>${fmt(s.daily.at(-1)?.installs ?? 0)}</b><span>installs active, latest day</span></div>
<div class="kpi"><b>${fmt(s.totals.installs7d)}</b><span>installs active, 7 days</span></div>
<div class="kpi"><b>${fmt(s.totals.installsEver)}</b><span>installs ever</span></div>
<div class="kpi"><b>${fmt(s.totals.turns30d)}</b><span>turns, 30 days</span></div>
<div class="kpi"><b>${fmt(s.totals.output30d)}</b><span>output tokens, 30 days</span></div></div>
<h2>Daily active installs (90 days)</h2>${bars(s.daily.map((d) => ({ label: d.day, value: d.installs })))}
<h2>Versions (last 7 days)</h2>${bars(s.versions.map((v) => ({ label: v.version, value: v.installs })))}
<h2>Platforms (last 7 days)</h2>${bars(s.platforms.map((p) => ({ label: p.platform, value: p.installs })))}
<h2>Output tokens by provider (30 days)</h2>${bars([...byDayProvider].map(([label, value]) => ({ label, value })))}
</main></body></html>`;
}
```

```ts
// services/telemetry/src/index.ts
import { validatePing } from './validate';
import { computeStats, renderStats, type D1Like } from './stats';

interface Env { DB: D1Like }
const MAX_BYTES = 4096;

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    try {
      if (url.pathname === '/v1/ping' && req.method === 'POST') {
        const raw = await req.text();
        if (raw.length > MAX_BYTES) return new Response(null, { status: 400 });
        let body: unknown;
        try { body = JSON.parse(raw); } catch { return new Response(null, { status: 400 }); }
        const now = new Date();
        const v = validatePing(body, now);
        if (!v.ok) return new Response(null, { status: 400 });
        const p = v.ping;
        for (const d of p.days) {
          await env.DB.prepare(`INSERT INTO pings (install_id, day, version, platform, providers, threads, chat_turns, projects, received_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(install_id, day) DO UPDATE SET version = excluded.version, platform = excluded.platform, providers = excluded.providers,
              threads = excluded.threads, chat_turns = excluded.chat_turns, projects = excluded.projects, received_at = excluded.received_at`)
            .bind(p.installId, d.day, p.version, p.platform, JSON.stringify(d.providers), d.threads, d.chatTurns, p.projects, now.toISOString()).run();
        }
        return new Response(null, { status: 204 });
      }
      // /stats* is guarded by Cloudflare Access at the edge; requests reach here only after login.
      if (req.method === 'GET' && url.pathname === '/stats.json') {
        return Response.json(await computeStats(env.DB, new Date()), { headers: { 'cache-control': 'no-store' } });
      }
      if (req.method === 'GET' && (url.pathname === '/stats' || url.pathname === '/stats/')) {
        return new Response(renderStats(await computeStats(env.DB, new Date())), { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
      }
      return new Response('Not found', { status: 404 });
    } catch {
      return new Response(null, { status: url.pathname === '/v1/ping' ? 400 : 500 });
    }
  },
};
```

The handler never reads `CF-Connecting-IP` or any header, and stores none.

- [ ] **Step 5: Run the tests and the typecheck**

Run: `cd services/telemetry && npx vitest run && npx tsc --noEmit -p .`
Expected: PASS (14 tests), no type errors.

- [ ] **Step 6: Commit**

```bash
git add services/telemetry
git commit -m "feat(telemetry): Cloudflare Worker — /v1/ping intake (D1 upsert) and Access-guarded /stats"
```

---

### Task 5: Deploy and verify live

**Files:**
- Modify: `services/telemetry/wrangler.toml` (the real `database_id`)

This task runs against the owner's Cloudflare account (wrangler is logged in as david@makoholdings.com; the Access app on `dispatchd.app/stats*` exists). It is done by the controller, not a subagent.

- [ ] **Step 1: Create the database and apply the schema**

```bash
cd services/telemetry
npx wrangler d1 create dispatch-telemetry        # prints database_id
# put that id into wrangler.toml database_id
npx wrangler d1 execute dispatch-telemetry --remote --file=schema.sql
```

- [ ] **Step 2: Deploy**

Run: `npx wrangler deploy`
Expected: route `dispatchd.app/*` listed. If the zone has no DNS record for the apex, add a proxied `AAAA dispatchd.app 100::` record (Workers routes need a proxied record) via the dashboard or the API with the wrangler token.

- [ ] **Step 3: Live probe from an isolated daemon build (no real data)**

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST https://dispatchd.app/v1/ping -d '{bad'          # 400
curl -s -o /dev/null -w "%{http_code}\n" https://dispatchd.app/stats                               # 302 to Access login
curl -s -o /dev/null -w "%{http_code}\n" https://dispatchd.app/                                    # 404
```

Then send one real report from code with a fixed test install id, check the row, and delete it:

```bash
npx wrangler d1 execute dispatch-telemetry --remote --command "SELECT install_id, day, version FROM pings"
npx wrangler d1 execute dispatch-telemetry --remote --command "DELETE FROM pings WHERE install_id = '<the test id>'"
```

- [ ] **Step 4: Keep test daemons out of the numbers**

The test copy on port 3999 restarts with `DISPATCH_TELEMETRY=0`. The vitest suites never reach the network (fetch is injected). Confirm with `rg -n "startTelemetryLoop" packages/core/src` that only `server.ts` starts the loop.

- [ ] **Step 5: Commit**

```bash
git add services/telemetry/wrangler.toml
git commit -m "chore(telemetry): bind the production D1 database"
```

- [ ] **Step 6: Ask the owner to open https://dispatchd.app/stats** and confirm the Access login and the page.
