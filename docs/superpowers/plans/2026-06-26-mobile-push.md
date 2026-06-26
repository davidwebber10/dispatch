# Mobile Push Notifications — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Web-push a notification when a thread finishes / needs input, to the user's subscribed devices that aren't currently foregrounded.

**Architecture:** Core gains a VAPID-backed `PushService` (subscriptions in SQLite + in-memory presence) and push routes; `StatusService` fires a hook on the `working → waiting/needs_input` transition; the PWA service worker shows the notification; the web client subscribes, reports foreground presence, and exposes a Settings toggle.

**Tech Stack:** TypeScript (ESM `.js` specifiers), better-sqlite3, Express, `web-push`, vitest+supertest (core); React/Vite + the existing `public/sw.js` (web).

## Global Constraints

- ESM `.js` import specifiers in core.
- VAPID private key lives ONLY server-side in `~/.dispatch/push.json` (0600); never sent to a client. Only the public key is exposed (`GET /api/push/key`).
- Trigger: a thread's persisted status goes `working` → `waiting` (idle/done) or `needs_input`. Fire once per transition.
- Away-only: send a push to a subscription's device only if that device is NOT currently foregrounded (presence `foreground===true` AND fresh, ≤90s). Missing/stale presence ⇒ treat as away (send).
- Push send is best-effort: wrap in try/catch, never let a failure affect the status pipeline; on a `404`/`410` statusCode, delete that subscription.
- Both `createApp` and `startServer` in `server.ts` must construct the `PushService`, mount the routes, and set the StatusService trigger hook (the two app paths stay in sync).
- v1: notification tap opens/focuses the app root (no per-thread deep-link — follow-up). The payload still carries `terminalId` for later.
- Web push on iOS works only for an installed PWA (Home Screen) on iOS 16.4+; the Settings enable flow detects non-installed iOS and guides instead of failing.

---

### Task 1: Core — `PushService` + subscriptions DB + routes

**Files:**
- Modify: `packages/core/package.json` (add `web-push`), `packages/core/src/db/schema.ts` (table)
- Create: `packages/core/src/db/push.ts`, `packages/core/src/push/service.ts`, `packages/core/src/routes/push.ts`
- Test: `packages/core/tests/push/service.test.ts`, `packages/core/tests/routes/push.test.ts`

**Interfaces:**
- Produces:
  - db `push.ts`: `interface PushSubscriptionRow { device_id, endpoint, p256dh, auth, created_at, updated_at }`; `interface PushSub { deviceId: string; endpoint: string; p256dh: string; auth: string }`; `upsert(db, sub): void`; `list(db): PushSub[]`; `remove(db, deviceId): void`; `removeByEndpoint(db, endpoint): void`.
  - `PushService` (constructor `(db, opts?: { vapidDir?: string; send?: Sender })`): `getPublicKey(): string`; `subscribe(deviceId, subscription): void`; `unsubscribe(deviceId): void`; `setPresence(deviceId, foreground): void`; `notifyThread(input: { terminalId: string; title: string; body: string }): Promise<void>`. Type `Sender = (sub: PushSub, payload: string) => Promise<void>` (a thin wrapper over `web-push.sendNotification`, injectable for tests).
  - `createPushRouter(push: PushService): Router` → `GET /key`, `POST /subscribe`, `POST /unsubscribe`, `POST /presence`.

- [ ] **Step 1: Add the dependency + table**

Run: `cd /Users/davidwebber/Sites/dispatch && pnpm --filter dispatch-server add web-push && pnpm --filter dispatch-server add -D @types/web-push`
In `packages/core/src/db/schema.ts`, add inside the `db.exec(\`…\`)` block (after the `integrations` table):
```sql
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      device_id   TEXT PRIMARY KEY,
      endpoint    TEXT NOT NULL,
      p256dh      TEXT NOT NULL,
      auth        TEXT NOT NULL,
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL
    );
```

- [ ] **Step 2: Write the failing db test**

Create `packages/core/tests/push/service.test.ts` (db portion first):
```ts
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import * as pushDb from '../../src/db/push.js';

function db() { const d = new Database(':memory:'); initSchema(d); return d; }

describe('push db', () => {
  let d: Database.Database;
  beforeEach(() => { d = db(); });
  it('upserts by device_id and lists', () => {
    pushDb.upsert(d, { deviceId: 'dev1', endpoint: 'https://e/1', p256dh: 'k', auth: 'a' });
    pushDb.upsert(d, { deviceId: 'dev1', endpoint: 'https://e/1b', p256dh: 'k2', auth: 'a2' }); // same device → replace
    pushDb.upsert(d, { deviceId: 'dev2', endpoint: 'https://e/2', p256dh: 'k', auth: 'a' });
    const all = pushDb.list(d);
    expect(all.length).toBe(2);
    expect(all.find((s) => s.deviceId === 'dev1')!.endpoint).toBe('https://e/1b');
  });
  it('removes by deviceId and by endpoint', () => {
    pushDb.upsert(d, { deviceId: 'dev1', endpoint: 'https://e/1', p256dh: 'k', auth: 'a' });
    pushDb.remove(d, 'dev1');
    expect(pushDb.list(d)).toEqual([]);
    pushDb.upsert(d, { deviceId: 'dev2', endpoint: 'https://e/2', p256dh: 'k', auth: 'a' });
    pushDb.removeByEndpoint(d, 'https://e/2');
    expect(pushDb.list(d)).toEqual([]);
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm --filter dispatch-server exec vitest run tests/push/service.test.ts`
Expected: FAIL — `db/push.js` not found.

- [ ] **Step 4: Implement `db/push.ts`**

```ts
import type Database from 'better-sqlite3';

export interface PushSub { deviceId: string; endpoint: string; p256dh: string; auth: string }
interface Row { device_id: string; endpoint: string; p256dh: string; auth: string }

export function upsert(db: Database.Database, s: PushSub): void {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO push_subscriptions (device_id, endpoint, p256dh, auth, created_at, updated_at)
    VALUES (@deviceId, @endpoint, @p256dh, @auth, @now, @now)
    ON CONFLICT(device_id) DO UPDATE SET endpoint=@endpoint, p256dh=@p256dh, auth=@auth, updated_at=@now`)
    .run({ ...s, now });
}
export function list(db: Database.Database): PushSub[] {
  return (db.prepare('SELECT device_id, endpoint, p256dh, auth FROM push_subscriptions').all() as Row[])
    .map((r) => ({ deviceId: r.device_id, endpoint: r.endpoint, p256dh: r.p256dh, auth: r.auth }));
}
export function remove(db: Database.Database, deviceId: string): void {
  db.prepare('DELETE FROM push_subscriptions WHERE device_id = ?').run(deviceId);
}
export function removeByEndpoint(db: Database.Database, endpoint: string): void {
  db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint);
}
```

- [ ] **Step 5: Run db test (pass)** — `pnpm --filter dispatch-server exec vitest run tests/push/service.test.ts` → PASS (2).

- [ ] **Step 6: Add PushService tests (append to the same file)**

```ts
import { PushService } from '../../src/push/service.js';
import fs from 'fs'; import os from 'os'; import path from 'path';
import * as terminalsDb from '../../src/db/terminals.js';
import * as sessionsDb from '../../src/db/sessions.js';

describe('PushService', () => {
  let d: Database.Database; let vapidDir: string; let sent: { sub: any; payload: string }[];
  function svc() {
    d = db(); vapidDir = fs.mkdtempSync(path.join(os.tmpdir(), 'push-'));
    sent = [];
    const s = new PushService(d, { vapidDir, send: async (sub, payload) => { sent.push({ sub, payload }); } });
    return s;
  }
  it('generates+persists a VAPID public key (stable across instances)', () => {
    const s = svc(); const k1 = s.getPublicKey();
    expect(k1).toBeTruthy();
    const s2 = new PushService(d, { vapidDir, send: async () => {} });
    expect(s2.getPublicKey()).toBe(k1);
  });
  it('notifyThread sends only to non-foregrounded devices', async () => {
    const s = svc();
    s.subscribe('dev-fg', { endpoint: 'https://e/fg', keys: { p256dh: 'k', auth: 'a' } });
    s.subscribe('dev-bg', { endpoint: 'https://e/bg', keys: { p256dh: 'k', auth: 'a' } });
    s.setPresence('dev-fg', true);   // foreground → suppressed
    s.setPresence('dev-bg', false);  // away → notified
    await s.notifyThread({ terminalId: 't1', title: 'Proj', body: 'Thread finished' });
    expect(sent.map((x) => x.sub.endpoint)).toEqual(['https://e/bg']);
  });
  it('prunes a subscription whose send throws a 410', async () => {
    d = db(); vapidDir = fs.mkdtempSync(path.join(os.tmpdir(), 'push-'));
    const s = new PushService(d, { vapidDir, send: async () => { const e: any = new Error('gone'); e.statusCode = 410; throw e; } });
    s.subscribe('dev', { endpoint: 'https://e/x', keys: { p256dh: 'k', auth: 'a' } });
    await s.notifyThread({ terminalId: 't1', title: 'P', body: 'done' });
    expect((await import('../../src/db/push.js')).list(d)).toEqual([]);
  });
});
```

- [ ] **Step 7: Run to verify those fail** — `pnpm --filter dispatch-server exec vitest run tests/push/service.test.ts` → FAIL (PushService missing).

- [ ] **Step 8: Implement `push/service.ts`**

```ts
import fs from 'fs';
import os from 'os';
import path from 'path';
import webpush from 'web-push';
import type Database from 'better-sqlite3';
import * as pushDb from '../db/push.js';

export type Sender = (sub: pushDb.PushSub, payload: string) => Promise<void>;
const PRESENCE_TTL_MS = 90_000;

export class PushService {
  private db: Database.Database;
  private vapid: { publicKey: string; privateKey: string };
  private send: Sender;
  private presence = new Map<string, { foreground: boolean; ts: number }>();

  constructor(db: Database.Database, opts: { vapidDir?: string; send?: Sender } = {}) {
    this.db = db;
    const dir = opts.vapidDir ?? path.join(os.homedir(), '.dispatch');
    this.vapid = this.loadOrCreateVapid(dir);
    webpush.setVapidDetails('mailto:dispatch@localhost', this.vapid.publicKey, this.vapid.privateKey);
    this.send = opts.send ?? (async (sub, payload) => {
      await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload);
    });
  }

  private loadOrCreateVapid(dir: string): { publicKey: string; privateKey: string } {
    const file = path.join(dir, 'push.json');
    try { const j = JSON.parse(fs.readFileSync(file, 'utf-8')); if (j.publicKey && j.privateKey) return j; } catch { /* create below */ }
    const keys = webpush.generateVAPIDKeys();
    try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(file, JSON.stringify(keys, null, 2), { mode: 0o600 }); } catch { /* ephemeral if unwritable */ }
    return keys;
  }

  getPublicKey(): string { return this.vapid.publicKey; }

  subscribe(deviceId: string, subscription: { endpoint: string; keys: { p256dh: string; auth: string } }): void {
    pushDb.upsert(this.db, { deviceId, endpoint: subscription.endpoint, p256dh: subscription.keys.p256dh, auth: subscription.keys.auth });
  }
  unsubscribe(deviceId: string): void { pushDb.remove(this.db, deviceId); }

  setPresence(deviceId: string, foreground: boolean): void { this.presence.set(deviceId, { foreground, ts: Date.now() }); }

  private isAway(deviceId: string): boolean {
    const p = this.presence.get(deviceId);
    if (!p) return true;                       // never reported → assume away (notify)
    if (Date.now() - p.ts > PRESENCE_TTL_MS) return true; // stale
    return !p.foreground;
  }

  async notifyThread(input: { terminalId: string; title: string; body: string }): Promise<void> {
    const payload = JSON.stringify({ title: input.title, body: input.body, terminalId: input.terminalId });
    for (const sub of pushDb.list(this.db)) {
      if (!this.isAway(sub.deviceId)) continue;
      try { await this.send(sub, payload); }
      catch (e: any) {
        const code = e?.statusCode;
        if (code === 404 || code === 410) pushDb.removeByEndpoint(this.db, sub.endpoint);
        else console.error('PushService: send failed', code ?? e?.message);
      }
    }
  }
}
```

- [ ] **Step 9: Run PushService tests (pass)** — `pnpm --filter dispatch-server exec vitest run tests/push/service.test.ts` → PASS (5 total).

- [ ] **Step 10: Routes + route test**

Create `packages/core/tests/routes/push.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import { createApp } from '../../src/server.js';

describe('push routes', () => {
  let app: any;
  beforeEach(() => { const db = new Database(':memory:'); initSchema(db); app = createApp({ db, skipPty: true }); });
  it('GET /key returns a public key', async () => {
    const res = await request(app).get('/api/push/key');
    expect(res.status).toBe(200);
    expect(typeof res.body.publicKey).toBe('string');
    expect(res.body.publicKey.length).toBeGreaterThan(0);
  });
  it('subscribe → unsubscribe and presence are accepted', async () => {
    const sub = { endpoint: 'https://e/1', keys: { p256dh: 'k', auth: 'a' } };
    expect((await request(app).post('/api/push/subscribe').send({ deviceId: 'd1', subscription: sub })).status).toBe(200);
    expect((await request(app).post('/api/push/presence').send({ deviceId: 'd1', foreground: true })).status).toBe(200);
    expect((await request(app).post('/api/push/unsubscribe').send({ deviceId: 'd1' })).status).toBe(200);
  });
  it('subscribe rejects a malformed body with 400', async () => {
    expect((await request(app).post('/api/push/subscribe').send({ deviceId: 'd1' })).status).toBe(400);
  });
});
```
Create `packages/core/src/routes/push.ts`:
```ts
import { Router } from 'express';
import type { PushService } from '../push/service.js';

export function createPushRouter(push: PushService): Router {
  const router = Router();
  router.get('/key', (_req, res) => res.json({ publicKey: push.getPublicKey() }));
  router.post('/subscribe', (req, res) => {
    const { deviceId, subscription } = req.body ?? {};
    if (typeof deviceId !== 'string' || !subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
      return res.status(400).json({ error: 'deviceId and a full subscription are required' });
    }
    push.subscribe(deviceId, subscription);
    res.json({ ok: true });
  });
  router.post('/unsubscribe', (req, res) => {
    if (typeof req.body?.deviceId !== 'string') return res.status(400).json({ error: 'deviceId required' });
    push.unsubscribe(req.body.deviceId);
    res.json({ ok: true });
  });
  router.post('/presence', (req, res) => {
    const { deviceId, foreground } = req.body ?? {};
    if (typeof deviceId !== 'string' || typeof foreground !== 'boolean') return res.status(400).json({ error: 'deviceId + foreground required' });
    push.setPresence(deviceId, foreground);
    res.json({ ok: true });
  });
  return router;
}
```
NOTE: the route test needs the router mounted — that happens in Task 2 (server wiring). To keep this task's tests green standalone, ALSO mount it now: in Task 2 you wire both apps; for THIS task, add the mount to `createApp` only (Step 11) so the route test passes here. (Task 2 adds `startServer` + the trigger.)

- [ ] **Step 11: Mount in `createApp` + construct PushService**

In `packages/core/src/server.ts` `createApp`, near the other service constructions (after `const integrationsService = new IntegrationsService(db);`):
```ts
  const pushService = new PushService(db, { vapidDir: dispatchDir });
```
(`dispatchDir` already exists in `createApp`.) Import `PushService` + `createPushRouter`. Add the mount with the other routes:
```ts
  app.use('/api/push', createPushRouter(pushService));
```
Attach for wiring/tests if helpful: `(app as any)._pushService = pushService;`

- [ ] **Step 12: Run both test files + tsc**

Run: `pnpm --filter dispatch-server exec vitest run tests/push/service.test.ts tests/routes/push.test.ts && pnpm --filter dispatch-server exec tsc --noEmit`
Expected: PASS (5 + 3); tsc clean.

- [ ] **Step 13: Commit**

```bash
git add packages/core/package.json pnpm-lock.yaml packages/core/src/db/schema.ts packages/core/src/db/push.ts packages/core/src/push/service.ts packages/core/src/routes/push.ts packages/core/tests/push/service.test.ts packages/core/tests/routes/push.test.ts packages/core/src/server.ts
git commit -m "feat(core): PushService (VAPID + subscriptions + away-only presence) + /api/push routes"
```

---

### Task 2: Core — StatusService trigger + `startServer` wiring

**Files:**
- Modify: `packages/core/src/status/service.ts` (transition hook)
- Modify: `packages/core/src/server.ts` (`startServer`: construct PushService, mount router, set hook; and set hook in `createApp` too)
- Test: `packages/core/tests/status/service.test.ts` (add transition-hook tests; create the file if absent — the status dir already has `events.ts`/`aggregate.ts` tests)

**Interfaces:**
- Consumes: `PushService.notifyThread` (Task 1); `sessionsDb`/`terminalsDb` for project name + thread label.
- Produces: `StatusService.setThreadSettledHook(fn: (info: { terminalId: string; sessionId: string; threadStatus: ThreadStatus }) => void)`.

- [ ] **Step 1: Write the failing transition test**

Create/extend `packages/core/tests/status/service.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import * as sessionsDb from '../../src/db/sessions.js';
import * as terminalsDb from '../../src/db/terminals.js';
import { StatusService } from '../../src/status/service.js';

function setup() {
  const db = new Database(':memory:'); initSchema(db);
  sessionsDb.create(db, { id: 's1', provider: 'claude-code', name: 'P', workingDir: '/tmp' });
  terminalsDb.create(db, { id: 't1', sessionId: 's1', type: 'claude-code', label: 'CC' });
  const broadcaster = { broadcast: () => {} } as any;
  const fired: any[] = [];
  const svc = new StatusService(db, broadcaster);
  svc.setThreadSettledHook((info) => fired.push(info));
  return { db, svc, fired };
}

describe('StatusService thread-settled hook', () => {
  it('fires when a thread goes working → idle', () => {
    const { svc, fired } = setup();
    svc.markWorking('t1');                 // → working
    svc.ingest('claude-code', 't1', { hook_event_name: 'Stop' }); // → idle (waiting)
    expect(fired.length).toBe(1);
    expect(fired[0]).toMatchObject({ terminalId: 't1', sessionId: 's1', threadStatus: 'idle' });
  });
  it('fires on working → needs_input', () => {
    const { svc, fired } = setup();
    svc.markWorking('t1');
    svc.ingest('claude-code', 't1', { hook_event_name: 'Notification', message: 'permission needed' });
    expect(fired.some((f) => f.threadStatus === 'needs_input')).toBe(true);
  });
  it('does NOT fire when already idle (no working→ transition)', () => {
    const { svc, fired } = setup();
    svc.ingest('claude-code', 't1', { hook_event_name: 'Stop' }); // starts non-working → idle
    expect(fired.length).toBe(0);
  });
});
```
(Adjust the `ingest` payloads to whatever `normalizeClaude` maps to `idle`/`needs_input` — check `status/events.ts`: `Stop` → idle; a `Notification` with a permission/idle hint → needs_input. Use payloads that produce those.)

- [ ] **Step 2: Run to verify it fails** — `pnpm --filter dispatch-server exec vitest run tests/status/service.test.ts` → FAIL (`setThreadSettledHook` missing).

- [ ] **Step 3: Add the hook to `StatusService`**

In `packages/core/src/status/service.ts`:
- Add a field + setter:
  ```ts
  private threadSettledHook: ((info: { terminalId: string; sessionId: string; threadStatus: ThreadStatus }) => void) | null = null;
  setThreadSettledHook(fn: (info: { terminalId: string; sessionId: string; threadStatus: ThreadStatus }) => void): void { this.threadSettledHook = fn; }
  ```
- In `apply(sessionId, terminalId, status, activity)`, read the prior persisted status BEFORE updating, and after updating fire the hook on a working→settled transition:
  ```ts
  private apply(sessionId: string, terminalId: string, status: ThreadStatus, activity?: string): void {
    const prior = terminalsDb.getById(this.db, terminalId)?.status;            // persisted enum
    const terminalStatus = TO_TERMINAL[status];
    try { terminalsDb.updateStatus(this.db, terminalId, terminalStatus); } catch { /* best effort */ }
    this.broadcaster.broadcast({ type: 'terminal:status', terminalId, status: terminalStatus, threadStatus: status, activity: activity ?? null });
    if (prior === 'working' && (terminalStatus === 'waiting' || terminalStatus === 'needs_input')) {
      try { this.threadSettledHook?.({ terminalId, sessionId, threadStatus: status }); } catch { /* hook must never break status */ }
    }
    this.aggregateSession(sessionId);
  }
  ```

- [ ] **Step 4: Run hook tests (pass)** — `pnpm --filter dispatch-server exec vitest run tests/status/service.test.ts` → PASS.

- [ ] **Step 5: Wire the hook + PushService into both apps**

In `server.ts`, add a small shared helper to build the push notification from a settled thread (DRY across both apps) — define it near the imports:
```ts
import * as terminalsDb2 from './db/terminals.js'; // if terminalsDb not already imported in this scope, reuse the existing import
import * as sessionsDb2 from './db/sessions.js';
```
(Prefer reusing existing `terminalsDb`/`sessionsDb` imports if present; do not double-import.) Then in BOTH `createApp` and `startServer`, after constructing `statusService` and `pushService`:
```ts
  statusService.setThreadSettledHook(({ terminalId, sessionId, threadStatus }) => {
    const term = terminalsDb.getById(db, terminalId);
    const sess = sessionsDb.getById(db, sessionId);
    const title = sess?.name || 'Dispatch';
    const label = term?.label || 'Thread';
    const body = threadStatus === 'needs_input' ? `${label} needs your input` : `${label} finished`;
    void pushService.notifyThread({ terminalId, title, body });
  });
```
In `startServer`, also `const pushService = new PushService(db, { vapidDir: dataDir });` and `app.use('/api/push', createPushRouter(pushService));` (mirroring `createApp`). `dataDir` already exists in `startServer`.

- [ ] **Step 6: Full core suite + tsc**

Run: `pnpm --filter dispatch-server exec vitest run && pnpm --filter dispatch-server exec tsc --noEmit`
Expected: all green; tsc clean.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/status/service.ts packages/core/src/server.ts packages/core/tests/status/service.test.ts
git commit -m "feat(core): fire push on thread working→idle/done/needs_input; wire PushService in both apps"
```

---

### Task 3: Service worker — push + notificationclick handlers

**Files:**
- Modify: `packages/web/public/sw.js`

**Interfaces:** consumes the push payload `{ title, body, terminalId }` from Task 1.

- [ ] **Step 1: Add handlers**

Append to `packages/web/public/sw.js`:
```js
self.addEventListener('push', (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch { d = {}; }
  const title = d.title || 'Dispatch';
  event.waitUntil(self.registration.showNotification(title, {
    body: d.body || '',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    tag: d.terminalId || undefined,   // coalesce repeated pings per thread
    data: { terminalId: d.terminalId || null },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const existing = all.find((c) => c.url.startsWith(self.location.origin));
    if (existing) { await existing.focus(); return; }
    await self.clients.openWindow('/');
  })());
});
```

- [ ] **Step 2: Verify the SW is valid + build**

Run: `cd /Users/davidwebber/Sites/dispatch && node --check packages/web/public/sw.js && echo SW-OK && pnpm --filter dispatch-web build`
Expected: `SW-OK`; build copies `public/sw.js` into `dist/` (Vite copies `public/` verbatim) — clean.

- [ ] **Step 3: Commit**

```bash
git add packages/web/public/sw.js
git commit -m "feat(web/sw): push + notificationclick handlers"
```

---

### Task 4: Web client — deviceId, presence, enable flow, Settings toggle

**Files:**
- Create: `packages/web/src/lib/push.ts` (deviceId + enable/disable + presence + base64 helper)
- Modify: `packages/web/src/api/client.ts` (push endpoints), `packages/web/src/api/types.ts` (none needed — inline), `packages/web/src/App.tsx` (presence wiring + stand down in-tab notify when push active), `packages/web/src/components/settings/SettingsModal.tsx` (the toggle), `packages/web/src/stores/settings.ts` (a `pushEnabled` flag)

**Interfaces:** consumes `GET /api/push/key`, `POST /api/push/{subscribe,unsubscribe,presence}` (Task 1).

- [ ] **Step 1: Client API methods**

In `packages/web/src/api/client.ts`, add:
```ts
  getPushKey: () => req<{ publicKey: string }>('/api/push/key'),
  pushSubscribe: (deviceId: string, subscription: unknown) => req<{ ok: true }>('/api/push/subscribe', { method: 'POST', body: body({ deviceId, subscription }) }),
  pushUnsubscribe: (deviceId: string) => req<{ ok: true }>('/api/push/unsubscribe', { method: 'POST', body: body({ deviceId }) }),
  pushPresence: (deviceId: string, foreground: boolean) => req<{ ok: true }>('/api/push/presence', { method: 'POST', body: body({ deviceId, foreground }) }),
```

- [ ] **Step 2: Push lib**

Create `packages/web/src/lib/push.ts`:
```ts
import { api } from '../api/client';

const DEVICE_KEY = 'dispatch:deviceId';
export function deviceId(): string {
  let id = localStorage.getItem(DEVICE_KEY);
  if (!id) { id = (crypto.randomUUID?.() ?? String(Math.random()).slice(2)); localStorage.setItem(DEVICE_KEY, id); }
  return id;
}

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export function pushSupported(): boolean {
  return typeof navigator !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && typeof Notification !== 'undefined';
}
/** On iOS, web push requires the PWA be installed (standalone display mode). */
export function iosNeedsInstall(): boolean {
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  if (!isIOS) return false;
  const standalone = window.matchMedia?.('(display-mode: standalone)')?.matches || (navigator as any).standalone === true;
  return !standalone;
}

async function ready(): Promise<ServiceWorkerRegistration> {
  // The PWA SW is registered by the app shell; ensure it exists.
  if (!navigator.serviceWorker.controller) { try { await navigator.serviceWorker.register('/sw.js'); } catch { /* ignore */ } }
  return navigator.serviceWorker.ready;
}

export async function enablePush(): Promise<'ok' | 'denied' | 'unsupported' | 'ios-install'> {
  if (!pushSupported()) return 'unsupported';
  if (iosNeedsInstall()) return 'ios-install';
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') return 'denied';
  const reg = await ready();
  const { publicKey } = await api.getPushKey();
  const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) });
  await api.pushSubscribe(deviceId(), sub.toJSON());
  return 'ok';
}
export async function disablePush(): Promise<void> {
  try { const reg = await navigator.serviceWorker.ready; const sub = await reg.pushManager.getSubscription(); await sub?.unsubscribe(); } catch { /* ignore */ }
  try { await api.pushUnsubscribe(deviceId()); } catch { /* ignore */ }
}
export function reportPresence(foreground: boolean): void {
  try { void api.pushPresence(deviceId(), foreground); } catch { /* ignore */ }
}
```

- [ ] **Step 3: `pushEnabled` in settings store**

In `packages/web/src/stores/settings.ts`: add `pushEnabled: boolean` to the interface + state (`pushEnabled: load('dispatch:pushEnabled', false)`), and a `setPushEnabled: (b: boolean) => Promise<void>`:
```ts
  setPushEnabled: async (b) => {
    if (b) {
      const r = await (await import('../lib/push')).enablePush();
      const on = r === 'ok';
      save('dispatch:pushEnabled', on); set({ pushEnabled: on });
      if (!on) throw new Error(r); // surfaced by the toggle for messaging (denied / unsupported / ios-install)
    } else {
      await (await import('../lib/push')).disablePush();
      save('dispatch:pushEnabled', false); set({ pushEnabled: false });
    }
  },
```

- [ ] **Step 4: Presence wiring + stand down in-tab notify**

In `packages/web/src/App.tsx`:
- Add a `useEffect` that reports presence on mount + visibility/focus changes (only when push is enabled):
  ```ts
  useEffect(() => {
    const report = () => { if (useSettings.getState().pushEnabled) (void import('./lib/push')).then((m) => m.reportPresence(document.visibilityState === 'visible' && document.hasFocus())); };
    report();
    document.addEventListener('visibilitychange', report);
    window.addEventListener('focus', report);
    window.addEventListener('blur', report);
    return () => { document.removeEventListener('visibilitychange', report); window.removeEventListener('focus', report); window.removeEventListener('blur', report); };
  }, []);
  ```
- In `maybeNotify`, stand down when push is active so a hidden-but-open tab isn't double-notified:
  ```ts
  function maybeNotify(sessionId: string) {
    const { notify, pushEnabled } = useSettings.getState();
    if (pushEnabled) return; // server push handles it (this tab counts as away)
    if (!notify || typeof Notification === 'undefined' || Notification.permission !== 'granted' || !document.hidden) return;
    const proj = useProjects.getState().sessions.find((x) => x.id === sessionId);
    try { new Notification('Dispatch — input needed', { body: proj?.name ?? 'A session needs your input', icon: '/icons/icon-192.png' }); } catch { /* ignore */ }
  }
  ```

- [ ] **Step 5: Settings toggle**

In `packages/web/src/components/settings/SettingsModal.tsx`, replace the existing `<div style={row}><span style={item}>Alert when input needed</span><Toggle … notify …/></div>` with a push toggle + inline status:
```tsx
              <div style={row}><span style={item}>Notify when a thread finishes</span><Toggle on={pushEnabled} onClick={() => void togglePush()} /></div>
              {pushMsg && <div style={{ fontSize: 11.5, color: 'var(--color-text-tertiary)' }}>{pushMsg}</div>}
```
Wire near the other settings selectors in the component:
```tsx
  const pushEnabled = useSettings((s) => s.pushEnabled);
  const [pushMsg, setPushMsg] = useState('');
  async function togglePush() {
    setPushMsg('');
    try { await useSettings.getState().setPushEnabled(!pushEnabled); }
    catch (e: any) {
      const r = String(e?.message);
      setPushMsg(r === 'ios-install' ? 'On iPhone/iPad, add Dispatch to your Home Screen first, then enable.'
        : r === 'unsupported' ? 'Push notifications aren’t supported in this browser.'
        : 'Notification permission was denied.');
    }
  }
```
(Keep `useState` imported — it already is in SettingsModal.)

- [ ] **Step 6: Typecheck + build**

Run: `pnpm --filter dispatch-web exec tsc --noEmit && pnpm --filter dispatch-web build`
Expected: both clean.

- [ ] **Step 7: Commit**

```bash
git add packages/web/src/lib/push.ts packages/web/src/api/client.ts packages/web/src/stores/settings.ts packages/web/src/App.tsx packages/web/src/components/settings/SettingsModal.tsx
git commit -m "feat(web): push enable flow + deviceId/presence + Settings toggle (iOS install guidance)"
```

---

## Self-Review

**1. Spec coverage:** VAPID + subscriptions + away-only presence + send/prune (T1); trigger on working→idle/done/needs_input + both-app wiring (T2); SW push/notificationclick (T3); deviceId + presence + enable flow + iOS guidance + Settings toggle + in-tab stand-down (T4). Notification tap opens/focuses app (v1; deep-link deferred — per spec). ✅
**2. Placeholder scan:** complete code + commands throughout; the one "adjust payloads to normalizeClaude" note in T2 Step 1 points at `status/events.ts` (Stop→idle; Notification permission→needs_input) — concrete, not a TBD. ✅
**3. Type consistency:** `PushSub`/subscription shape consistent db↔service↔routes↔client; `notifyThread({terminalId,title,body})` used in T2 hook; `setThreadSettledHook` signature consistent T2; `pushEnabled`/`setPushEnabled` consistent store↔settings UI; payload `{title,body,terminalId}` consistent service↔SW. ✅

## Activation (manual, by the user)

New core routes + the status trigger need a daemon restart: `pnpm --filter dispatch-server build && ./bin/dispatch restart` (ends the dev session). Then, on the phone: install the PWA (Home Screen), open Settings → enable "Notify when a thread finishes", grant permission, background the app, run a thread → push on completion.
