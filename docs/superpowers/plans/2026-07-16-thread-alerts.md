# Per-Thread Alerts (Bell) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Per-thread alert toggle (bell) that pushes a web notification when that thread settles (asks a question / finishes), with notification tap deep-linking to the thread's terminal.

**Architecture:** The flag lives in the thread's existing `config` JSON blob (`alertsEnabled`), gated server-side at the existing `threadSettledHook`. Presence reports gain the actively-viewed terminal id so the server skips only the device watching the resolving thread. Deep links reuse the mobile URL scheme `/p/<sessionId>/t/<terminalId>` plus a cross-shell zustand intent.

**Tech Stack:** Node/Express/better-sqlite3 (packages/core), React/zustand/Vite (packages/web), web-push + service worker, vitest.

**Spec:** `docs/superpowers/specs/2026-07-16-thread-alerts-design.md`

## Global Constraints

- Notification copy is EXACTLY: title = thread label; body = `Is asking a question` (needs_input) or `Completed its task` (settled to waiting). Never model content.
- Config key is EXACTLY `alertsEnabled`; when turning off, DELETE the key (never store `alertsEnabled: false`) — mirrors the `pinned` convention.
- Alert UI only for `claude-code` / `codex` threads, and only when `canReceiveAlerts()` is true. No bell UI of any kind in incapable contexts.
- Never use the generic `PATCH /api/terminals/:id` for the flag — it replaces the whole config blob. Server-side merge only.
- Suppression rule: skip a device only when its presence is fresh (≤90s), foreground, AND `activeTerminalId === terminalId`. Everyone else gets the push.
- Run all commands from the repo root at `/Users/davidwebber/Sites/dispatch/.claude/worktrees/thread-alerts` (this worktree). Never cd to the main checkout.
- Commit after every task (messages given per task).

---

### Task 1: PushService — presence carries the viewed thread; suppression rule; payload sessionId

**Files:**
- Modify: `packages/core/src/push/service.ts`
- Modify: `packages/core/src/routes/push.ts`
- Test: `packages/core/src/push/service.test.ts` (create)

**Interfaces:**
- Consumes: existing `pushDb` helpers (`packages/core/src/db/push.ts`: `upsert`, `list`, `remove`, `removeByEndpoint`; `PushSub = { deviceId, endpoint, p256dh, auth }`).
- Produces: `PushService.setPresence(deviceId: string, foreground: boolean, activeTerminalId?: string | null): void`; `PushService.notifyThread(input: { terminalId: string; sessionId: string; title: string; body: string }): Promise<void>` (payload JSON now includes `sessionId`). Route `POST /api/push/presence` accepts optional `activeTerminalId: string | null`.

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/push/service.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type Database from 'better-sqlite3';
import { createDatabase } from '../db/connection.js';
import * as pushDb from '../db/push.js';
import { PushService } from './service.js';

let dir: string;
let db: Database.Database;
let sent: { deviceId: string; payload: any }[];
let svc: PushService;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-push-'));
  db = createDatabase(path.join(dir, 'test.db'));
  sent = [];
  svc = new PushService(db, {
    vapidDir: dir,
    send: async (sub, payload) => { sent.push({ deviceId: sub.deviceId, payload: JSON.parse(payload) }); },
  });
  pushDb.upsert(db, { deviceId: 'phone', endpoint: 'https://push/phone', p256dh: 'k', auth: 'a' });
  pushDb.upsert(db, { deviceId: 'desk', endpoint: 'https://push/desk', p256dh: 'k', auth: 'a' });
});
afterEach(() => {
  vi.useRealTimers();
  try { db.close(); } catch { /* ignore */ }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
});

const notify = () => svc.notifyThread({ terminalId: 't1', sessionId: 's1', title: 'Claude Code 37', body: 'Completed its task' });

describe('PushService presence rule — notify unless viewing it', () => {
  it('notifies devices that never reported presence', async () => {
    await notify();
    expect(sent.map((s) => s.deviceId).sort()).toEqual(['desk', 'phone']);
  });

  it('notifies a background device', async () => {
    svc.setPresence('phone', false, null);
    await notify();
    expect(sent.map((s) => s.deviceId).sort()).toEqual(['desk', 'phone']);
  });

  it('notifies a foreground device viewing a DIFFERENT thread', async () => {
    svc.setPresence('desk', true, 'other-thread');
    await notify();
    expect(sent.map((s) => s.deviceId).sort()).toEqual(['desk', 'phone']);
  });

  it('skips only the foreground device viewing THIS thread', async () => {
    svc.setPresence('desk', true, 't1');
    await notify();
    expect(sent.map((s) => s.deviceId)).toEqual(['phone']);
  });

  it('stops suppressing once presence goes stale (>90s)', async () => {
    vi.useFakeTimers();
    svc.setPresence('desk', true, 't1');
    vi.advanceTimersByTime(91_000);
    await notify();
    expect(sent.map((s) => s.deviceId).sort()).toEqual(['desk', 'phone']);
  });

  it('includes sessionId and terminalId in the payload (deep link data)', async () => {
    await notify();
    expect(sent[0].payload).toMatchObject({ terminalId: 't1', sessionId: 's1', title: 'Claude Code 37', body: 'Completed its task' });
  });

  it('prunes a subscription when the endpoint returns 410', async () => {
    svc = new PushService(db, {
      vapidDir: dir,
      send: async (sub) => { if (sub.deviceId === 'phone') { const e: any = new Error('gone'); e.statusCode = 410; throw e; } },
    });
    await notify();
    expect(pushDb.list(db).map((s) => s.deviceId)).toEqual(['desk']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @dispatch/core exec vitest run src/push/service.test.ts`
(If the package name filter fails, use: `cd packages/core && npx vitest run src/push/service.test.ts` — check `packages/core/package.json` `name` field first.)
Expected: FAIL — `setPresence` doesn't accept a third argument / suppression still uses `isAway` / payload lacks `sessionId` (compile or assertion errors).

- [ ] **Step 3: Implement in `packages/core/src/push/service.ts`**

Replace the `presence` map, `setPresence`, `isAway`, and `notifyThread` with:

```ts
  private presence = new Map<string, { foreground: boolean; activeTerminalId: string | null; ts: number }>();
```

```ts
  setPresence(deviceId: string, foreground: boolean, activeTerminalId: string | null = null): void {
    this.presence.set(deviceId, { foreground, activeTerminalId, ts: Date.now() });
  }

  /** "Notify unless viewing it": suppress only a fresh, foregrounded report of THIS thread. */
  private isViewing(deviceId: string, terminalId: string): boolean {
    const p = this.presence.get(deviceId);
    if (!p) return false;
    if (Date.now() - p.ts > PRESENCE_TTL_MS) return false;
    return p.foreground && p.activeTerminalId === terminalId;
  }

  async notifyThread(input: { terminalId: string; sessionId: string; title: string; body: string }): Promise<void> {
    const payload = JSON.stringify({ title: input.title, body: input.body, terminalId: input.terminalId, sessionId: input.sessionId });
    for (const sub of pushDb.list(this.db)) {
      if (this.isViewing(sub.deviceId, input.terminalId)) continue;
      try { await this.send(sub, payload); }
      catch (e: any) {
        const code = e?.statusCode;
        if (code === 404 || code === 410) pushDb.removeByEndpoint(this.db, sub.endpoint);
        else console.error('PushService: send failed', code ?? e?.message);
      }
    }
  }
```

Delete the old `isAway` method entirely (nothing else uses it).

In `packages/core/src/routes/push.ts`, replace the `/presence` handler:

```ts
  router.post('/presence', (req, res) => {
    const { deviceId, foreground, activeTerminalId } = req.body ?? {};
    if (typeof deviceId !== 'string' || typeof foreground !== 'boolean') return res.status(400).json({ error: 'deviceId + foreground required' });
    if (activeTerminalId !== undefined && activeTerminalId !== null && typeof activeTerminalId !== 'string') {
      return res.status(400).json({ error: 'activeTerminalId must be a string or null' });
    }
    push.setPresence(deviceId, foreground, activeTerminalId ?? null);
    res.json({ ok: true });
  });
```

Note: `server.ts` still calls `notifyThread({ terminalId, title, body })` without `sessionId` — that call site is replaced in Task 2. To keep the core package compiling between tasks, Task 1 and Task 2 are committed together only if `tsc` fails; otherwise commit separately (the settled hook has `sessionId` in scope, so a minimal interim fix is to pass `sessionId` there — do that in Task 1 if the typecheck complains, and Task 2 will replace the whole block anyway).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/core && npx vitest run src/push/service.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Typecheck the package**

Run: `cd packages/core && npx tsc --noEmit`
Expected: clean, except possibly the `notifyThread` call sites in `server.ts` missing `sessionId` — if so, add `sessionId` to both existing settled-hook calls (`server.ts` in `createApp` and in `startServer`): `void pushService.notifyThread({ terminalId, sessionId, title, body });`

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/push/service.ts packages/core/src/routes/push.ts packages/core/src/push/service.test.ts packages/core/src/server.ts
git commit -m "feat(core): presence tracks viewed thread; notify unless viewing it"
```

---

### Task 2: Settled-hook gate — one shared wiring, per-thread opt-in, template copy

**Files:**
- Create: `packages/core/src/push/notify.ts`
- Modify: `packages/core/src/server.ts` (both settled-hook registrations)
- Test: `packages/core/src/push/notify.test.ts` (create)

**Interfaces:**
- Consumes: `StatusService.setThreadSettledHook` (`packages/core/src/status/service.ts:33`), `PushService.notifyThread` (Task 1 signature, with `sessionId`), `terminalsDb.getById` (returns raw row: `label` string, `config` JSON string).
- Produces: `wireThreadSettledPush(db: Database.Database, statusService: StatusService, pushService: Pick<PushService, 'notifyThread'>): void`

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/push/notify.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type Database from 'better-sqlite3';
import { createDatabase } from '../db/connection.js';
import * as sessionsDb from '../db/sessions.js';
import * as terminalsDb from '../db/terminals.js';
import { StatusService } from '../status/service.js';
import { wireThreadSettledPush } from './notify.js';

const fakeBroadcaster = { broadcast: () => {} } as any;

let dir: string;
let db: Database.Database;
let statusService: StatusService;
let notifyThread: ReturnType<typeof vi.fn>;

function seedThread(id: string, config: Record<string, any>) {
  terminalsDb.create(db, { id, sessionId: 's1', type: 'claude-code', label: `Claude Code ${id}`, config });
  terminalsDb.updateStatus(db, id, 'working'); // settled hook fires only on working → settled edges
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-notify-'));
  db = createDatabase(path.join(dir, 'test.db'));
  sessionsDb.create(db, { id: 's1', provider: 'claude-code', name: 'proj', workingDir: '/tmp/proj' });
  statusService = new StatusService(db, fakeBroadcaster);
  notifyThread = vi.fn().mockResolvedValue(undefined);
  wireThreadSettledPush(db, statusService, { notifyThread } as any);
});
afterEach(() => {
  try { db.close(); } catch { /* ignore */ }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('wireThreadSettledPush — per-thread gate + template copy', () => {
  it('does NOT push for a thread without alertsEnabled', () => {
    seedThread('t1', {});
    statusService.markIdle('t1');
    expect(notifyThread).not.toHaveBeenCalled();
  });

  it('pushes "Completed its task" when a bell-enabled thread goes idle', () => {
    seedThread('t2', { alertsEnabled: true });
    statusService.markIdle('t2');
    expect(notifyThread).toHaveBeenCalledWith({
      terminalId: 't2', sessionId: 's1', title: 'Claude Code t2', body: 'Completed its task',
    });
  });

  it('pushes "Is asking a question" on needs_input', () => {
    seedThread('t3', { alertsEnabled: true });
    statusService.markNeedsInput('t3');
    expect(notifyThread).toHaveBeenCalledWith({
      terminalId: 't3', sessionId: 's1', title: 'Claude Code t3', body: 'Is asking a question',
    });
  });

  it('fires only on the working → settled edge (no repeat when already idle)', () => {
    seedThread('t4', { alertsEnabled: true });
    statusService.markIdle('t4');
    statusService.markIdle('t4'); // prior status is now 'waiting' — no edge
    expect(notifyThread).toHaveBeenCalledTimes(1);
  });

  it('treats a malformed config blob as alerts-off', () => {
    seedThread('t5', {});
    db.prepare('UPDATE terminals SET config = ? WHERE id = ?').run('{not json', 't5');
    statusService.markIdle('t5');
    expect(notifyThread).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/core && npx vitest run src/push/notify.test.ts`
Expected: FAIL — `wireThreadSettledPush` module not found.

- [ ] **Step 3: Create `packages/core/src/push/notify.ts`**

```ts
import type Database from 'better-sqlite3';
import * as terminalsDb from '../db/terminals.js';
import type { StatusService } from '../status/service.js';
import type { PushService } from './service.js';

/**
 * Wires the "thread settled" edge (working → needs_input/waiting) to web push.
 * Per-thread opt-in: only threads with config.alertsEnabled (the bell UI) alert.
 * Copy is template-only — thread label + what happened, never model content.
 */
export function wireThreadSettledPush(
  db: Database.Database,
  statusService: StatusService,
  pushService: Pick<PushService, 'notifyThread'>,
): void {
  statusService.setThreadSettledHook(({ terminalId, sessionId, threadStatus }) => {
    const row = terminalsDb.getById(db, terminalId);
    if (!row) return;
    let config: Record<string, any> = {};
    try { config = JSON.parse(row.config || '{}'); } catch { /* malformed → alerts off */ }
    if (config.alertsEnabled !== true) return;
    const body = threadStatus === 'needs_input' ? 'Is asking a question' : 'Completed its task';
    void pushService.notifyThread({ terminalId, sessionId, title: row.label || 'Thread', body });
  });
}
```

(If `row.label` doesn't exist on the raw row type, check `packages/core/src/db/terminals.ts` for the column name on `getById`'s return — the existing hooks in `server.ts` use `term?.label`, so `label` is correct.)

- [ ] **Step 4: Replace BOTH hook registrations in `packages/core/src/server.ts`**

In `createApp` (currently ~line 186) and in `startServer` (currently ~line 312), delete the whole `statusService.setThreadSettledHook({ ... })` block and replace each with:

```ts
  wireThreadSettledPush(db, statusService, pushService);
```

Add the import near the other push import:

```ts
import { wireThreadSettledPush } from './push/notify.js';
```

Remove the now-unused `sessionsDb.getById` usage if it was only for the old title (check: `sessionsDb` is used elsewhere in server.ts — only remove the import if it becomes unused; run tsc to confirm).

- [ ] **Step 5: Run tests + typecheck**

Run: `cd packages/core && npx vitest run src/push/ && npx tsc --noEmit`
Expected: PASS (Task 1 + Task 2 files), clean typecheck.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/push/notify.ts packages/core/src/push/notify.test.ts packages/core/src/server.ts
git commit -m "feat(core): per-thread alertsEnabled gate at the settled hook, template copy"
```

---

### Task 3: Alerts toggle endpoint — server-side config merge

**Files:**
- Modify: `packages/core/src/sessions/service.ts` (next to `setAutoArchive`, ~line 499)
- Modify: `packages/core/src/routes/terminals.ts` (next to the auto-archive route, ~line 299)
- Test: `packages/core/src/sessions/alerts.test.ts` (create)

**Interfaces:**
- Consumes: `terminalsDb.getById`, `terminalsDb.rowToTerminal`, `terminalsDb.updateConfig` (all already used by `setAutoArchive`).
- Produces: `SessionService.setAlertsEnabled(terminalId: string, enabled: boolean): terminalsDb.Terminal | null`; route `PATCH /api/terminals/:terminalId/alerts` body `{ enabled: boolean }` → the updated Terminal JSON, broadcasting `session:tabs-changed`.

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/sessions/alerts.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type Database from 'better-sqlite3';
import { createDatabase } from '../db/connection.js';
import * as sessionsDb from '../db/sessions.js';
import * as terminalsDb from '../db/terminals.js';
import { SessionService } from './service.js';

const fakePty = { isAlive: () => false, kill: () => {} } as any;

let dir: string;
let db: Database.Database;
let svc: SessionService;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-alerts-'));
  db = createDatabase(path.join(dir, 'test.db'));
  sessionsDb.create(db, { id: 's1', provider: 'claude-code', name: 'proj', workingDir: '/tmp/proj' });
  terminalsDb.create(db, { id: 't1', sessionId: 's1', type: 'claude-code', label: 't1', config: { transport: 'structured', pinned: true } });
  svc = new SessionService(db, fakePty, path.join(dir, 'mcp.json'));
});
afterEach(() => {
  try { db.close(); } catch { /* ignore */ }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('SessionService.setAlertsEnabled', () => {
  it('sets alertsEnabled without clobbering other config keys', () => {
    const t = svc.setAlertsEnabled('t1', true);
    expect(t?.config).toMatchObject({ alertsEnabled: true, transport: 'structured', pinned: true });
  });

  it('deletes the key on disable (no alertsEnabled:false noise)', () => {
    svc.setAlertsEnabled('t1', true);
    const t = svc.setAlertsEnabled('t1', false);
    expect(t?.config).not.toHaveProperty('alertsEnabled');
    expect(t?.config).toMatchObject({ transport: 'structured', pinned: true });
  });

  it('returns null for an unknown terminal', () => {
    expect(svc.setAlertsEnabled('nope', true)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/core && npx vitest run src/sessions/alerts.test.ts`
Expected: FAIL — `setAlertsEnabled is not a function`.

- [ ] **Step 3: Implement**

In `packages/core/src/sessions/service.ts`, directly below `setAutoArchive` (~line 505):

```ts
  /**
   * Toggle per-thread push alerts (the bell). Merges server-side for the same
   * reason as setAutoArchive: the generic PATCH replaces the config blob wholesale.
   * Disable deletes the key so configs don't accumulate `alertsEnabled: false`.
   */
  setAlertsEnabled(terminalId: string, enabled: boolean): terminalsDb.Terminal | null {
    const row = terminalsDb.getById(this.db, terminalId);
    if (!row) return null;
    const config = { ...terminalsDb.rowToTerminal(row).config } as Record<string, any>;
    if (enabled) config.alertsEnabled = true; else delete config.alertsEnabled;
    terminalsDb.updateConfig(this.db, terminalId, config);
    return terminalsDb.rowToTerminal(terminalsDb.getById(this.db, terminalId)!);
  }
```

In `packages/core/src/routes/terminals.ts`, directly below the auto-archive route (~line 309):

```ts
  // PATCH /api/terminals/:terminalId/alerts — merge the per-thread alert flag
  // server-side (same rationale as auto-archive: the generic PATCH clobbers config).
  router.patch('/terminals/:terminalId/alerts', (req, res) => {
    const { enabled } = req.body;
    if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be a boolean' });
    const terminal = sessionService.setAlertsEnabled(req.params.terminalId, enabled);
    if (!terminal) return res.status(404).json({ error: 'Terminal not found' });
    broadcaster?.broadcast({ type: 'session:tabs-changed', sessionId: terminal.sessionId });
    res.json(terminal);
  });
```

- [ ] **Step 4: Run test + full core suite**

Run: `cd packages/core && npx vitest run && npx tsc --noEmit`
Expected: all core tests PASS, clean typecheck.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/sessions/service.ts packages/core/src/routes/terminals.ts packages/core/src/sessions/alerts.test.ts
git commit -m "feat(core): PATCH /api/terminals/:id/alerts with server-side config merge"
```

---

### Task 4: Web store + API client — setAlertsEnabled action

**Files:**
- Modify: `packages/web/src/api/client.ts` (push section, ~line 208)
- Modify: `packages/web/src/stores/tabs.ts` (below `setPinned`, ~line 119)
- Test: `packages/web/src/stores/tabs-alerts.test.ts` (create)

**Interfaces:**
- Consumes: Task 3's `PATCH /api/terminals/:id/alerts`; existing `findTerminal`, `loadTabs` in tabs store.
- Produces: `api.setTerminalAlerts(id: string, enabled: boolean): Promise<Terminal>`; `api.pushPresence(deviceId: string, foreground: boolean, activeTerminalId?: string | null)`; store action `useTabs.setAlertsEnabled(id: string, enabled: boolean): Promise<void>` (optimistic, reverts via `loadTabs` on failure).

- [ ] **Step 1: Write the failing test**

Create `packages/web/src/stores/tabs-alerts.test.ts` (check `packages/web/src/App.test.tsx` for the project's vitest environment conventions first — jsdom is configured; mirror its mock style):

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useTabs } from './tabs';
import { api } from '../api/client';
import type { Terminal } from '../api/types';

vi.mock('../api/client', () => ({
  api: {
    setTerminalAlerts: vi.fn().mockResolvedValue({}),
    listTerminals: vi.fn().mockResolvedValue([]),
  },
}));

const thread = (over: Partial<Terminal> = {}): Terminal => ({
  id: 't1', sessionId: 's1', type: 'claude-code', label: 'Claude Code 37',
  status: 'waiting', config: { transport: 'structured' }, createdAt: '', lastActivityAt: '',
  ...over,
} as Terminal);

beforeEach(() => {
  vi.clearAllMocks();
  useTabs.setState({ byProject: { s1: [thread()] }, tabSession: { t1: 's1' } });
});

describe('useTabs.setAlertsEnabled', () => {
  it('optimistically sets config.alertsEnabled and calls the dedicated endpoint', async () => {
    await useTabs.getState().setAlertsEnabled('t1', true);
    const t = useTabs.getState().byProject.s1[0];
    expect(t.config).toMatchObject({ alertsEnabled: true, transport: 'structured' });
    expect(api.setTerminalAlerts).toHaveBeenCalledWith('t1', true);
  });

  it('deletes the key on disable', async () => {
    useTabs.setState({ byProject: { s1: [thread({ config: { alertsEnabled: true } as any })] } });
    await useTabs.getState().setAlertsEnabled('t1', false);
    expect(useTabs.getState().byProject.s1[0].config).not.toHaveProperty('alertsEnabled');
  });

  it('reloads server truth when the call fails', async () => {
    (api.setTerminalAlerts as any).mockRejectedValueOnce(new Error('boom'));
    await useTabs.getState().setAlertsEnabled('t1', true);
    expect(api.listTerminals).toHaveBeenCalledWith('s1');
  });
});
```

If `Terminal` in `packages/web/src/api/types.ts` has required fields not covered above, satisfy them in the `thread()` factory (read the type first).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/web && npx vitest run src/stores/tabs-alerts.test.ts`
Expected: FAIL — `setAlertsEnabled is not a function`.

- [ ] **Step 3: Implement**

`packages/web/src/api/client.ts` — in the push section, extend `pushPresence` and add the alerts call:

```ts
  pushPresence: (deviceId: string, foreground: boolean, activeTerminalId: string | null = null) =>
    req<{ ok: true }>('/api/push/presence', { method: 'POST', body: body({ deviceId, foreground, activeTerminalId }) }),
  setTerminalAlerts: (id: string, enabled: boolean) =>
    req<Terminal>(`/api/terminals/${id}/alerts`, { method: 'PATCH', body: body({ enabled }) }),
```

(Keep the existing `pushPresence` callers compiling — the new parameter has a default. `Terminal` is already imported in client.ts; verify, else import the type.)

`packages/web/src/stores/tabs.ts` — add to the `TabsState` interface:

```ts
  setAlertsEnabled: (id: string, enabled: boolean) => Promise<void>; // per-thread push alerts (config.alertsEnabled)
```

and implement below `setPinned`:

```ts
  setAlertsEnabled: async (id, enabled) => {
    const t = findTerminal(get().byProject, id);
    if (!t) return;
    // Dedicated merge endpoint (NOT the generic PATCH — that clobbers config);
    // optimistic local merge so the bell flips instantly.
    const config = { ...t.config } as Record<string, unknown>;
    if (enabled) config.alertsEnabled = true; else delete config.alertsEnabled;
    const byProject = { ...get().byProject };
    byProject[t.sessionId] = (byProject[t.sessionId] ?? []).map((x) => (x.id === id ? { ...x, config } : x));
    set({ byProject });
    try { await api.setTerminalAlerts(id, enabled); }
    catch (e) { console.error('useTabs.setAlertsEnabled: failed, reverting', e); await get().loadTabs(t.sessionId); }
  },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/web && npx vitest run src/stores/tabs-alerts.test.ts && npx tsc -b --dry 2>/dev/null || npx tsc -b`
Expected: PASS; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/api/client.ts packages/web/src/stores/tabs.ts packages/web/src/stores/tabs-alerts.test.ts
git commit -m "feat(web): setAlertsEnabled store action + dedicated alerts endpoint client"
```

---

### Task 5: Capability check, viewing store, presence upgrade, legacy notify removal

**Files:**
- Modify: `packages/web/src/lib/push.ts`
- Create: `packages/web/src/stores/viewing.ts`
- Modify: `packages/web/src/App.tsx` (presence effect, `maybeNotify` removal, viewing wiring)
- Modify: `packages/web/src/components/mobile/MobileApp.tsx` (viewing wiring)
- Modify: `packages/web/src/stores/settings.ts` (remove `notify`)
- Modify: `packages/web/src/components/settings/SettingsModal.tsx` (relabel row, reuse error mapper)

**Interfaces:**
- Consumes: `pushSupported()`, `iosNeedsInstall()` (existing in lib/push.ts); `useSettings.setPushEnabled` (existing).
- Produces: `canReceiveAlerts(): boolean`; `pushErrorMessage(code: string): string`; `ensurePushEnrolled(): Promise<string | null>` (null = enrolled OK, string = user-facing error); `reportPresence(foreground: boolean, activeTerminalId?: string | null): void`; `useViewing` store `{ id: string | null; set(id: string | null): void }`.

- [ ] **Step 1: Add to `packages/web/src/lib/push.ts`**

```ts
/** Can THIS context receive web push? Gates every piece of alert UI (design:
 *  incapable contexts show no bell at all — e.g. iOS Safari in-browser, plain-http origins). */
export function canReceiveAlerts(): boolean {
  return pushSupported() && !iosNeedsInstall() && window.isSecureContext;
}

/** One place for enrollment-failure copy (shared by Settings and the bell toggles). */
export function pushErrorMessage(code: string): string {
  return code === 'ios-install' ? 'On iPhone/iPad, add Dispatch to your Home Screen first, then enable.'
    : code === 'unsupported' ? 'Push notifications aren\'t supported in this browser.'
    : code === 'denied' ? 'Notification permission was denied.'
    : 'Couldn\'t enable push notifications — please try again.';
}

/** Enroll this device (permission prompt + subscription) if it isn't already.
 *  Returns null on success, a user-facing message on failure. Must be called
 *  from a user gesture (the permission prompt requires it). */
export async function ensurePushEnrolled(): Promise<string | null> {
  const { useSettings } = await import('../stores/settings'); // dynamic: settings.ts imports this module
  if (useSettings.getState().pushEnabled) return null;
  try { await useSettings.getState().setPushEnabled(true); return null; }
  catch (e: any) { return pushErrorMessage(String(e?.message)); }
}
```

Replace `reportPresence`:

```ts
export function reportPresence(foreground: boolean, activeTerminalId: string | null = null): void {
  void api.pushPresence(deviceId(), foreground, activeTerminalId).catch(() => {});
}
```

- [ ] **Step 2: Create `packages/web/src/stores/viewing.ts`**

```ts
import { create } from 'zustand';

/** The terminal the user is looking at RIGHT NOW (null when none — e.g. mobile
 *  thread list, dispatch tab, blurred app). Feeds presence reports so the server
 *  skips alerting only the device already watching the resolving thread. */
export const useViewing = create<{ id: string | null; set: (id: string | null) => void }>((set) => ({
  id: null,
  set: (id) => set({ id }),
}));
```

- [ ] **Step 3: Rewire `packages/web/src/App.tsx`**

1. Delete the `maybeNotify` function (lines 37–43) and its call site (the `if (e.type === 'session:status' ...) maybeNotify(...)` line inside the events socket `onEvent`).
2. Replace the presence-reporting effect (lines 87–94) with:

```ts
  useEffect(() => {
    const report = () => {
      if (!useSettings.getState().pushEnabled) return;
      const fg = document.visibilityState === 'visible' && document.hasFocus();
      void import('./lib/push').then((m) => m.reportPresence(fg, fg ? useViewing.getState().id : null)).catch(() => {});
    };
    report();
    const unsub = useViewing.subscribe(report); // re-report when the viewed thread changes
    document.addEventListener('visibilitychange', report);
    window.addEventListener('focus', report);
    window.addEventListener('blur', report);
    return () => { unsub(); document.removeEventListener('visibilitychange', report); window.removeEventListener('focus', report); window.removeEventListener('blur', report); };
  }, []);
```

3. Add desktop viewing wiring (below the presence effect; `isMobile` and `activeTerminalId` are already in scope):

```ts
  // Desktop: the active tab IS the viewed thread. Mobile: MobileApp owns this
  // (its level-2 leaf state), so don't fight it from here.
  useEffect(() => {
    if (isMobile) return;
    useViewing.getState().set(activeTerminalId && !isDispatchTab(activeTerminalId) ? activeTerminalId : null);
  }, [activeTerminalId, isMobile]);
```

4. Add the import: `import { useViewing } from './stores/viewing';`

- [ ] **Step 4: Mobile viewing wiring in `packages/web/src/components/mobile/MobileApp.tsx`**

Add import `import { useViewing } from '../../stores/viewing';` and, near the other effects (~line 108):

```ts
  // Presence: the thread terminal is "being viewed" only on the level-2 tab leaf.
  useEffect(() => {
    useViewing.getState().set(level === 2 && leaf === 'tab' ? leafTabId : null);
    return () => useViewing.getState().set(null);
  }, [level, leaf, leafTabId]);
```

- [ ] **Step 5: Remove the legacy `notify` setting**

- `packages/web/src/stores/settings.ts`: delete `notify: boolean;` and `setNotify: (b: boolean) => Promise<void>;` from the interface, the `notify: load('dispatch:notify', false),` initializer, and the whole `setNotify` implementation.
- `packages/web/src/components/settings/SettingsModal.tsx`: delete `const notify = useSettings((s) => s.notify);` (line ~245). Relabel the push row (line ~364) from `Notify when a thread finishes` to `Push notifications on this device`, and add a hint line right below it (before the `{pushMsg && ...}` line):

```tsx
              <div style={row}><span style={item}>Push notifications on this device</span><Toggle on={pushEnabled} onClick={() => void togglePush()} /></div>
              <div style={{ fontSize: 11.5, color: 'var(--color-text-tertiary)' }}>Alerts are armed per thread with the bell — this enables this device to receive them.</div>
```

- In `togglePush` (line ~248), replace the inline ternary chain with the shared mapper:

```ts
  async function togglePush() {
    setPushMsg('');
    try { await useSettings.getState().setPushEnabled(!pushEnabled); }
    catch (e: any) {
      const { pushErrorMessage } = await import('../../lib/push');
      setPushMsg(pushErrorMessage(String(e?.message)));
    }
  }
```

- Search for any other `notify` readers: `grep -rn "\.notify\b\|'dispatch:notify'\|setNotify" packages/web/src` — remove/adjust every hit (expected: only settings.ts, SettingsModal.tsx, App.tsx).

- [ ] **Step 6: Run web tests + typecheck**

Run: `cd packages/web && npx vitest run && npx tsc -b`
Expected: PASS (App.test.tsx must still pass with maybeNotify gone — if it referenced `notify`, update the test's settings seeding accordingly), typecheck clean.

- [ ] **Step 7: Commit**

```bash
git add packages/web/src/lib/push.ts packages/web/src/stores/viewing.ts packages/web/src/App.tsx packages/web/src/components/mobile/MobileApp.tsx packages/web/src/stores/settings.ts packages/web/src/components/settings/SettingsModal.tsx
git commit -m "feat(web): canReceiveAlerts + viewed-thread presence; retire global notify"
```

---

### Task 6: Bell UI — row indicator, context menu, header toggle

**Files:**
- Create: `packages/web/src/components/layout/AlertBell.tsx`
- Modify: `packages/web/src/components/sidebar/ProjectCard.tsx` (ThreadRow ~line 129, ctx menu ~line 455)
- Modify: `packages/web/src/components/tabs/TabHost.tsx` (floating group, ~line 44)
- Modify: `packages/web/src/components/mobile/MobileApp.tsx` (header, ~line 155)

**Interfaces:**
- Consumes: `useTabs.setAlertsEnabled` (Task 4), `canReceiveAlerts` / `ensurePushEnrolled` (Task 5).
- Produces: `AlertBell({ terminalId, floating? })` component (renders nothing for non-agent threads or incapable contexts).

- [ ] **Step 1: Create `packages/web/src/components/layout/AlertBell.tsx`** (pattern: ModeToggle.tsx)

```tsx
import { useState } from 'react';
import { Bell } from '@phosphor-icons/react';
import { useTabs, findTerminal } from '../../stores/tabs';
import { canReceiveAlerts, ensurePushEnrolled } from '../../lib/push';

/**
 * Per-thread alert (bell) toggle for an AI thread's header. Two looks, mirroring
 * ModeToggle: compact inline pill (mobile header) and floating glassy (desktop,
 * over the terminal's top-right). Renders nothing for non-agent threads or in a
 * context that can't receive web push — per design, incapable contexts show no
 * alert UI at all. Enabling from an un-enrolled device runs enrollment inline.
 */
export function AlertBell({ terminalId, floating = false }: { terminalId: string | null | undefined; floating?: boolean }) {
  const tab = useTabs((s) => (terminalId ? findTerminal(s.byProject, terminalId) : undefined));
  const [busy, setBusy] = useState(false);
  if (!terminalId || !tab || (tab.type !== 'claude-code' && tab.type !== 'codex')) return null;
  if (!canReceiveAlerts()) return null;
  const on = !!(tab.config as { alertsEnabled?: boolean })?.alertsEnabled;
  const toggle = async () => {
    if (busy) return;
    setBusy(true);
    try {
      if (!on) { const err = await ensurePushEnrolled(); if (err) { window.alert(err); return; } }
      await useTabs.getState().setAlertsEnabled(terminalId, !on);
    } finally { setBusy(false); }
  };
  const dim = floating ? { w: 46, h: 32, icon: 19, radius: 9, pad: 3 } : { w: 36, h: 24, icon: 15, radius: 6, pad: 2 };
  return (
    <div style={{
      display: 'flex', padding: dim.pad,
      borderRadius: floating ? 11 : 8,
      background: floating ? 'rgba(22,22,26,0.55)' : 'var(--color-elevated)',
      border: floating ? '1px solid rgba(255,255,255,0.10)' : '1px solid #2C2C32',
      ...(floating ? { backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)', boxShadow: '0 6px 18px -8px rgba(0,0,0,.6)' } : {}),
    }}>
      <button title={on ? 'Alerts on — click to disable' : 'Alerts off — click to enable'} onClick={() => void toggle()} style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center', width: dim.w, height: dim.h, borderRadius: dim.radius, border: 'none', cursor: 'pointer',
        background: on ? (floating ? 'rgba(255,255,255,0.14)' : 'var(--color-hover)') : 'transparent',
        color: on ? 'var(--color-accent)' : 'var(--color-text-secondary)',
        transition: 'background .12s ease, color .12s ease',
      }}>
        <Bell size={dim.icon} weight={on ? 'fill' : 'regular'} />
      </button>
    </div>
  );
}
```

- [ ] **Step 2: Row indicator in `packages/web/src/components/sidebar/ProjectCard.tsx`**

In `ThreadRow`, directly after the pinned indicator block (lines 129–131), add (both mobile AND desktop — no `isMobile` gate):

```tsx
      {(tab.type === 'claude-code' || tab.type === 'codex') && (tab.config as { alertsEnabled?: boolean })?.alertsEnabled && canReceiveAlerts() && (
        <Bell size={13} weight="fill" color="var(--color-text-tertiary)" style={{ flexShrink: 0, marginLeft: 4 }} />
      )}
```

Imports: add `Bell` to the existing `@phosphor-icons/react` import; add `import { canReceiveAlerts, ensurePushEnrolled } from '../../lib/push';`.

- [ ] **Step 3: Context menu item**

In the thread context menu (after the pin/unpin button, ~line 460), add:

```tsx
            {(ctxMenu.tab.type === 'claude-code' || ctxMenu.tab.type === 'codex') && canReceiveAlerts() && (
              <button onClick={() => { const t = ctxMenu.tab; setCtxMenu(null); void toggleAlerts(t); }} style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left', padding: '7px 9px', background: 'transparent', border: 'none', borderRadius: 6, color: 'var(--color-text-primary)', cursor: 'pointer', fontSize: 13 }}>{(ctxMenu.tab.config as { alertsEnabled?: boolean })?.alertsEnabled ? 'Disable alerts' : 'Enable alerts'}</button>
            )}
```

Add the helper inside the `ProjectCard` component (near `archive`/`branch` — find them with grep):

```ts
  async function toggleAlerts(tab: Terminal) {
    const on = !(tab.config as { alertsEnabled?: boolean })?.alertsEnabled;
    if (on) { const err = await ensurePushEnrolled(); if (err) { window.alert(err); return; } }
    void useTabs.getState().setAlertsEnabled(tab.id, on);
  }
```

- [ ] **Step 4: Header placements**

`packages/web/src/components/tabs/TabHost.tsx` — in the desktop floating group (lines 43–48), add the bell first:

```tsx
        <div style={{ position: 'absolute', top: 4, right: 12, zIndex: 12, display: 'flex', gap: 6 }}>
          <AlertBell terminalId={tab.id} floating />
          <TransportToggle terminalId={tab.id} floating />
          {!structured && <ModeToggle terminalId={tab.id} floating />}
        </div>
```

`packages/web/src/components/mobile/MobileApp.tsx` — in the header actions div (~line 154), before `<ModeToggle ...>`:

```tsx
          <AlertBell terminalId={level === 2 && leaf === 'tab' ? leafTabId : null} />
```

Imports in both files: `import { AlertBell } from '../layout/AlertBell';`

- [ ] **Step 5: Verify**

Run: `cd packages/web && npx vitest run && npx tsc -b`
Expected: PASS + clean. Then a quick visual dev check is optional (`pnpm --filter web dev`), but the real end-to-end check happens in Task 8.

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/components/layout/AlertBell.tsx packages/web/src/components/sidebar/ProjectCard.tsx packages/web/src/components/tabs/TabHost.tsx packages/web/src/components/mobile/MobileApp.tsx
git commit -m "feat(web): bell indicator, context-menu toggle, header AlertBell"
```

---

### Task 7: Deep link — service worker tap-through + both-shell navigation

**Files:**
- Modify: `packages/web/public/sw.js`
- Modify: `packages/web/src/stores/ui.ts`
- Create: `packages/web/src/lib/deepLink.ts`
- Modify: `packages/web/src/App.tsx`
- Modify: `packages/web/src/components/mobile/MobileApp.tsx`
- Test: `packages/web/src/lib/deepLink.test.ts` (create)

**Interfaces:**
- Consumes: push payload `{ terminalId, sessionId }` (Task 1); mobile's native `/p/:sessionId/t/:terminalId` cold-start restore (already exists, `MobileApp.tsx:111-132`).
- Produces: SW `notificationclick` → focus + `postMessage({ type: 'open-thread', terminalId, sessionId })`, or `openWindow('/p/<sessionId>/t/<terminalId>')`; `useUI.pendingOpenThread: { sessionId: string; terminalId: string } | null` with `requestOpenThread(v)` / `clearOpenThread()`; `parseThreadPath(path: string): { sessionId: string; terminalId: string } | null`.

- [ ] **Step 1: Write the failing test**

Create `packages/web/src/lib/deepLink.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseThreadPath } from './deepLink';

describe('parseThreadPath', () => {
  it('parses /p/<sessionId>/t/<terminalId>', () => {
    expect(parseThreadPath('/p/s-123/t/t-456')).toEqual({ sessionId: 's-123', terminalId: 't-456' });
  });
  it('rejects everything else', () => {
    expect(parseThreadPath('/')).toBeNull();
    expect(parseThreadPath('/p/s-123')).toBeNull();
    expect(parseThreadPath('/p/s-123/a/agent-1')).toBeNull();
    expect(parseThreadPath('/p/s-123/t/t-456/extra')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/web && npx vitest run src/lib/deepLink.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `packages/web/src/lib/deepLink.ts`**

```ts
/** Parse the thread deep-link URL the SW opens on notification tap. Matches the
 *  mobile nav scheme (/p/<sessionId>/t/<terminalId>) so mobile restores it natively;
 *  the desktop shell parses it with this and converts it to an open-thread intent. */
export function parseThreadPath(path: string): { sessionId: string; terminalId: string } | null {
  const m = path.match(/^\/p\/([^/]+)\/t\/([^/]+)$/);
  return m ? { sessionId: m[1], terminalId: m[2] } : null;
}
```

- [ ] **Step 4: Service worker (`packages/web/public/sw.js`)**

1. Bump `const VERSION = 'dispatch-v3';` → `'dispatch-v4'`.
2. In the `push` handler's `showNotification` options, extend `data`:

```js
    data: { terminalId: d.terminalId || null, sessionId: d.sessionId || null },
```

3. Replace the `notificationclick` handler:

```js
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const { terminalId, sessionId } = event.notification.data || {};
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const existing = all.find((c) => c.url.startsWith(self.location.origin));
    if (existing) {
      await existing.focus();
      // Warm path: the running app navigates via the open-thread intent.
      if (terminalId && sessionId) existing.postMessage({ type: 'open-thread', terminalId, sessionId });
      return;
    }
    // Cold path: the mobile shell restores /p/<s>/t/<t> natively; desktop parses it at boot.
    await self.clients.openWindow(terminalId && sessionId ? `/p/${sessionId}/t/${terminalId}` : '/');
  })());
});
```

- [ ] **Step 5: Intent in `packages/web/src/stores/ui.ts`**

Add to the store type (below `clearOpenTab`):

```ts
  // Cross-shell "open this thread (possibly in another project)" intent — set by
  // the SW notification tap / deep-link boot, consumed by whichever shell is live.
  pendingOpenThread: { sessionId: string; terminalId: string } | null;
  requestOpenThread: (v: { sessionId: string; terminalId: string }) => void;
  clearOpenThread: () => void;
```

and to the implementation:

```ts
  pendingOpenThread: null,
  requestOpenThread: (v) => set({ pendingOpenThread: v }),
  clearOpenThread: () => set({ pendingOpenThread: null }),
```

- [ ] **Step 6: App wiring (`packages/web/src/App.tsx`)**

1. Imports: `import { useUI } from './stores/ui';`, `import { parseThreadPath } from './lib/deepLink';`, and add `findTerminal` to the existing tabs import.
2. In the init `useEffect`, change the hydrate line so the desktop cold-start deep link applies AFTER hydrate (hydrate would otherwise overwrite the active tab):

```ts
    void useTabs.getState().hydrate().then(() => {
      if (window.innerWidth <= 768) return; // MobileApp restores /p/… URLs natively
      const deep = parseThreadPath(location.pathname);
      if (deep) { history.replaceState({}, '', '/'); useUI.getState().requestOpenThread(deep); }
    });
```

3. Also in the init `useEffect`, register the SW message listener (warm path, both shells):

```ts
    const onSwMessage = (e: MessageEvent) => {
      const d = e.data as { type?: string; sessionId?: string; terminalId?: string } | null;
      if (d?.type === 'open-thread' && d.sessionId && d.terminalId) {
        useUI.getState().requestOpenThread({ sessionId: d.sessionId, terminalId: d.terminalId });
      }
    };
    navigator.serviceWorker?.addEventListener('message', onSwMessage);
```

and in the effect's cleanup: `navigator.serviceWorker?.removeEventListener('message', onSwMessage);`

4. Desktop consumer (new effect after the viewing effect):

```ts
  // Desktop consumer of the open-thread intent (mobile's lives in MobileApp).
  const pendingThread = useUI((s) => s.pendingOpenThread);
  useEffect(() => {
    if (!pendingThread || isMobile) return;
    const { sessionId, terminalId } = pendingThread;
    useUI.getState().clearOpenThread();
    void (async () => {
      try { await useTabs.getState().loadTabs(sessionId); } catch { return; } // project gone → open normally
      if (!findTerminal(useTabs.getState().byProject, terminalId)) return;    // thread gone → open normally
      useProjects.getState().setActive(sessionId);
      useTabs.getState().setActiveTab(terminalId);
    })();
  }, [pendingThread, isMobile]);
```

- [ ] **Step 7: Mobile consumer (`packages/web/src/components/mobile/MobileApp.tsx`)**

Below the `pendingOpenTab` effect (~line 107):

```ts
  // SW notification tap while the app is running: jump straight to that thread,
  // seeding the project first (openThreadFromList handles cross-project moves).
  const pendingThread = useUI((s) => s.pendingOpenThread);
  useEffect(() => {
    if (!pendingThread) return;
    useUI.getState().clearOpenThread();
    openThreadFromList(pendingThread.sessionId, pendingThread.terminalId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingThread]);
```

(`useUI` is already imported in MobileApp.tsx.)

- [ ] **Step 8: Run tests + typecheck**

Run: `cd packages/web && npx vitest run && npx tsc -b`
Expected: PASS + clean.

- [ ] **Step 9: Commit**

```bash
git add packages/web/public/sw.js packages/web/src/stores/ui.ts packages/web/src/lib/deepLink.ts packages/web/src/lib/deepLink.test.ts packages/web/src/App.tsx packages/web/src/components/mobile/MobileApp.tsx
git commit -m "feat(web): notification tap deep-links to the thread (warm intent + cold /p URL)"
```

---

### Task 8: Spec amendment, full build, isolated-daemon smoke test

**Files:**
- Modify: `docs/superpowers/specs/2026-07-16-thread-alerts-design.md` (deep-link section)
- No code changes expected (fix anything the verification uncovers).

- [ ] **Step 1: Amend the spec's Deep-link section**

In `docs/superpowers/specs/2026-07-16-thread-alerts-design.md`, replace the entire `### Deep-link` section body with:

```markdown
- **Push payload** carries `{ terminalId, sessionId }` (sessionId added for URL building).
- **Service worker** (`public/sw.js`): on `notificationclick`, if a dispatch window
  exists → `focus()` + `postMessage({ type: 'open-thread', terminalId, sessionId })`;
  else `openWindow('/p/<sessionId>/t/<terminalId>')` — the mobile shell's existing
  URL scheme, which it restores natively on cold start.
- **Warm path**: the message becomes a `useUI.pendingOpenThread` intent; the live
  shell consumes it (desktop: `loadTabs` + `setActiveTab`; mobile:
  `openThreadFromList`, which seeds the project and builds the history stack).
- **Desktop cold start**: `App` parses `/p/<sessionId>/t/<terminalId>`
  (`lib/deepLink.ts`) after tab hydration (hydration would otherwise overwrite the
  restored tab), converts it to the same intent, and cleans the URL with
  `history.replaceState`. Unknown/archived thread → open normally, no error UI.
```

Also update the spec's Architecture → Web bullet mentioning the `?thread=` query param (`?thread=` appears in the "Out of scope" section too — change that line to "Any URL routing framework — deep links reuse the existing `/p/…/t/…` mobile scheme").

- [ ] **Step 2: Full monorepo build + tests**

```bash
pnpm -r build && pnpm -r test
```
Expected: both packages build; all tests pass.

- [ ] **Step 3: Isolated daemon smoke test (never touch the real ~/.dispatch)**

```bash
FAKEHOME=$(mktemp -d)
HOME="$FAKEHOME" PORT=3999 DISPATCH_WEB_DIST=packages/web/dist node packages/core/dist/server.js &
sleep 2
# seed a project + thread
SID=$(curl -s -X POST localhost:3999/api/sessions -H 'content-type: application/json' -d '{"name":"smoke","workingDir":"/tmp"}' | jq -r .id)
TID=$(curl -s -X POST localhost:3999/api/sessions/$SID/terminals -H 'content-type: application/json' -d '{"type":"claude-code","label":"Claude Code smoke"}' | jq -r .id)
# toggle alerts on via the new endpoint; confirm merge
curl -s -X PATCH localhost:3999/api/terminals/$TID/alerts -H 'content-type: application/json' -d '{"enabled":true}' | jq .config
# presence accepts activeTerminalId
curl -s -X POST localhost:3999/api/push/presence -H 'content-type: application/json' -d '{"deviceId":"d1","foreground":true,"activeTerminalId":"'"$TID"'"}'
kill %1
```
Expected: config JSON shows `"alertsEnabled": true` (plus any defaults), presence returns `{"ok":true}`. If the terminals-create route shape differs, check `packages/core/src/routes/terminals.ts` for the actual create endpoint and adjust. (The `verify` skill can drive a fuller WS/status-transition pass if anything looks off.)

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-07-16-thread-alerts-design.md
git commit -m "docs: amend thread-alerts spec deep-link section to as-built"
```

---

## Manual verification (post-merge, by the user — listed for completeness)

1. Phone PWA (Cloudflare HTTPS origin): enable a thread's bell from the context menu or header → lock the phone → let the thread finish → notification "Claude Code 37 / Completed its task" → tap → lands in that thread's terminal.
2. Desktop browser: bell on a thread, focus a different thread → system notification appears; click → app focuses that thread. While viewing the resolving thread → no notification.
3. iOS Safari (NOT installed as PWA): no bell anywhere (row, menu, header).
