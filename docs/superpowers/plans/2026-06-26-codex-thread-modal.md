# New Codex Thread Modal (parity with Claude) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `NewCodexThreadModal` (name + resume-recent) mirroring `NewClaudeThreadModal`, opened from the Codex item in the new-thread menu.

**Architecture:** A new backend lister parses Codex's `~/.codex/sessions/**/rollout-*.jsonl` rollout files (filtering by the project's cwd) and a route exposes them; the web layer mirrors the Claude modal/wiring against `type:'codex'` (resume via the existing `codex resume <id>`).

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), better-sqlite3/Express, vitest + supertest (core); React + Vite + @testing-library (web).

## Global Constraints

- ESM with `.js` import specifiers in all core TypeScript imports.
- Mirror the Claude implementation's shapes exactly: the recent-session object is `{ id: string; mtime: number; preview: string; messageCount: number; truncated: boolean }` (identical to `RecentCcSession`/`CcRecentSession`).
- Codex resume uses the existing `codex.ts` `buildResumeCommand` (`codex resume <externalSessionId>`) — pass the picked session's id as `externalId` to `createTerminal`. No provider changes.
- The lister never throws — returns `[]` on any failure (missing dir, unreadable/malformed files).
- No "branch" affordance in the modal (the Claude modal has none either).
- Web has no unit-test runner for components beyond what's mocked; the modal test uses @testing-library + vitest exactly like `NewClaudeThreadModal.test.tsx`.

---

### Task 1: Backend — Codex session lister + route

**Files:**
- Create: `packages/core/src/sessions/codex-sessions.ts`
- Modify: `packages/core/src/routes/sessions.ts` (add import + `GET /:id/codex-recent`, mirroring the existing `cc-recent` route)
- Test: `packages/core/tests/sessions/codex-sessions.test.ts`

**Interfaces:**
- Produces (consumed by Task 2): `interface RecentCodexSession { id: string; mtime: number; preview: string; messageCount: number; truncated: boolean }` and `listRecentCodexSessions(workDir: string, limit?: number, root?: string): Promise<RecentCodexSession[]>` (the optional `root` defaults to `~/.codex/sessions` and exists for testability).
- Route: `GET /api/sessions/:id/codex-recent` → `RecentCodexSession[]`.

- [ ] **Step 1: Write the failing test**

Create `packages/core/tests/sessions/codex-sessions.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { listRecentCodexSessions } from '../../src/sessions/codex-sessions.js';

function writeRollout(root: string, rel: string, lines: any[], mtimeMs?: number) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  if (mtimeMs) fs.utimesSync(full, mtimeMs / 1000, mtimeMs / 1000);
  return full;
}

describe('listRecentCodexSessions', () => {
  let root: string;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'codexsess-')); });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  it('lists matching-cwd sessions newest-first with preview + count', async () => {
    const now = Date.now();
    writeRollout(root, '2026/06/01/rollout-a.jsonl', [
      { type: 'session_meta', payload: { session_id: 'sess-a', cwd: '/work/proj' } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'first task' }] } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] } },
    ], now - 60000);
    writeRollout(root, '2026/06/02/rollout-b.jsonl', [
      { type: 'session_meta', payload: { session_id: 'sess-b', cwd: '/work/proj' } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'second task' }] } },
    ], now);

    const list = await listRecentCodexSessions('/work/proj', 20, root);
    expect(list.map((s) => s.id)).toEqual(['sess-b', 'sess-a']);
    expect(list[0]).toMatchObject({ id: 'sess-b', preview: 'second task', messageCount: 1, truncated: false });
    expect(list[1]).toMatchObject({ id: 'sess-a', preview: 'first task', messageCount: 2 });
  });

  it('excludes sessions from other cwds', async () => {
    writeRollout(root, '2026/06/01/rollout-x.jsonl', [
      { type: 'session_meta', payload: { session_id: 'x', cwd: '/other' } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] } },
    ]);
    expect(await listRecentCodexSessions('/work/proj', 20, root)).toEqual([]);
  });

  it('returns [] when the sessions dir is missing', async () => {
    expect(await listRecentCodexSessions('/work/proj', 20, path.join(root, 'nope'))).toEqual([]);
  });

  it('skips a malformed file without throwing', async () => {
    fs.mkdirSync(path.join(root, '2026/06/03'), { recursive: true });
    fs.writeFileSync(path.join(root, '2026/06/03/rollout-bad.jsonl'), 'not json\n{also not');
    writeRollout(root, '2026/06/03/rollout-good.jsonl', [
      { type: 'session_meta', payload: { session_id: 'good', cwd: '/work/proj' } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'ok' }] } },
    ]);
    const list = await listRecentCodexSessions('/work/proj', 20, root);
    expect(list.map((s) => s.id)).toEqual(['good']);
  });

  it('falls back to a default preview when there is no user message', async () => {
    writeRollout(root, '2026/06/04/rollout-c.jsonl', [
      { type: 'session_meta', payload: { session_id: 'c', cwd: '/work/proj' } },
    ]);
    const list = await listRecentCodexSessions('/work/proj', 20, root);
    expect(list).toEqual([{ id: 'c', mtime: expect.any(Number), preview: 'New session', messageCount: 0, truncated: false }]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter dispatch-server exec vitest run tests/sessions/codex-sessions.test.ts`
Expected: FAIL — module `codex-sessions.js` not found.

- [ ] **Step 3: Implement the lister**

Create `packages/core/src/sessions/codex-sessions.ts`:

```ts
import fs from 'fs';
import os from 'os';
import path from 'path';

export interface RecentCodexSession {
  id: string;          // Codex session_id (uuid)
  mtime: number;       // last-modified epoch ms
  preview: string;     // first user message, trimmed
  messageCount: number;
  truncated: boolean;  // count is a lower bound (file larger than the scanned head)
}

const HEAD_BYTES = 128 * 1024;  // scan only the head — previews/meta are near the top
const SCAN_CAP = 300;           // bound work: sessions aren't organized by cwd

function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((p): p is { type: string; text: string } =>
        !!p && typeof (p as any).text === 'string' && ['input_text', 'text', 'output_text'].includes((p as any).type))
      .map((p) => p.text)
      .join(' ');
  }
  return '';
}

async function readHead(file: string, size: number): Promise<{ text: string; truncated: boolean }> {
  if (size <= HEAD_BYTES) return { text: await fs.promises.readFile(file, 'utf-8'), truncated: false };
  const fh = await fs.promises.open(file, 'r');
  try {
    const buf = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    return { text: buf.subarray(0, bytesRead).toString('utf-8'), truncated: true };
  } finally { await fh.close(); }
}

/**
 * List a project's recent Codex sessions (for the "resume" picker), newest first.
 * Codex writes rollout files at ~/.codex/sessions/<Y>/<M>/<D>/rollout-<ts>-<uuid>.jsonl;
 * line 1 is { type:'session_meta', payload:{ session_id, cwd } }, followed by
 * { type:'response_item', payload:{ type:'message', role, content } } lines.
 * Sessions aren't organized by cwd, so we stat+sort every rollout by mtime and read
 * newest-first until `limit` match `workDir`. Never throws — returns [] on failure.
 */
export async function listRecentCodexSessions(
  workDir: string,
  limit = 20,
  root = path.join(os.homedir(), '.codex', 'sessions'),
): Promise<RecentCodexSession[]> {
  let entries: string[];
  try { entries = (await fs.promises.readdir(root, { recursive: true })) as string[]; }
  catch { return []; }
  const rollouts = entries.filter((p) => {
    const b = path.basename(p);
    return b.startsWith('rollout-') && b.endsWith('.jsonl');
  });

  const stated = (await Promise.all(rollouts.map(async (rel) => {
    const full = path.join(root, rel);
    try { const s = await fs.promises.stat(full); return { full, mtime: s.mtimeMs, size: s.size }; }
    catch { return null; }
  }))).filter((x): x is { full: string; mtime: number; size: number } => !!x);

  stated.sort((a, b) => b.mtime - a.mtime);

  const out: RecentCodexSession[] = [];
  for (const f of stated.slice(0, SCAN_CAP)) {
    if (out.length >= limit) break;
    try {
      const { text, truncated } = await readHead(f.full, f.size);
      const lines = text.split('\n');
      let sessionId = '';
      let cwd = '';
      let metaSeen = false;
      let preview = '';
      let messageCount = 0;
      for (const ln of lines) {
        if (!ln.trim()) continue;
        let o: any;
        try { o = JSON.parse(ln); } catch { continue; }  // partial trailing line when truncated
        if (!metaSeen && o?.type === 'session_meta') {
          sessionId = typeof o.payload?.session_id === 'string' ? o.payload.session_id : '';
          cwd = typeof o.payload?.cwd === 'string' ? o.payload.cwd : '';
          metaSeen = true;
          if (cwd !== workDir) break;  // wrong project — stop scanning this file
          continue;
        }
        if (metaSeen && o?.type === 'response_item' && o.payload?.type === 'message') {
          const role = o.payload.role;
          if (role !== 'user' && role !== 'assistant') continue;
          messageCount++;
          if (!preview && role === 'user') {
            const t = extractText(o.payload.content).replace(/\s+/g, ' ').trim();
            if (t && !t.startsWith('<')) preview = t.slice(0, 120);
          }
        }
      }
      if (!metaSeen || cwd !== workDir || !sessionId) continue;
      out.push({ id: sessionId, mtime: f.mtime, preview: (preview || 'New session').slice(0, 120), messageCount, truncated });
    } catch { /* skip unreadable file */ }
  }
  return out;
}
```

- [ ] **Step 4: Run lister tests**

Run: `pnpm --filter dispatch-server exec vitest run tests/sessions/codex-sessions.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Add the route**

In `packages/core/src/routes/sessions.ts`: add the import next to the existing cc-sessions import (which reads `import { listRecentSessions } from '../sessions/cc-sessions.js';`):

```ts
import { listRecentCodexSessions } from '../sessions/codex-sessions.js';
```

And add this route immediately AFTER the existing `router.get('/:id/cc-recent', …)` handler block (mirror it exactly):

```ts
  // GET /api/sessions/:id/codex-recent — recent Codex sessions in this project's
  // folder, for the new-thread "resume" picker.
  router.get('/:id/codex-recent', async (req, res) => {
    const session = sessionService.get(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    try { res.json(await listRecentCodexSessions(session.workingDir)); }
    catch { res.json([]); }
  });
```

- [ ] **Step 6: Add a route test**

Create `packages/core/tests/routes/codex-recent.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import { createApp } from '../../src/server.js';

describe('GET /api/sessions/:id/codex-recent', () => {
  let app: any;
  beforeEach(() => { const db = new Database(':memory:'); initSchema(db); app = createApp({ db, skipPty: true }); });

  it('404s for an unknown session', async () => {
    const res = await request(app).get('/api/sessions/nope/codex-recent');
    expect(res.status).toBe(404);
  });

  it('returns an array for a real session', async () => {
    const created = await request(app).post('/api/sessions').send({ provider: 'codex', name: 'cx', workingDir: '/tmp/does-not-exist-xyz' });
    const res = await request(app).get(`/api/sessions/${created.body.id}/codex-recent`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});
```

- [ ] **Step 7: Run route + lister tests**

Run: `pnpm --filter dispatch-server exec vitest run tests/sessions/codex-sessions.test.ts tests/routes/codex-recent.test.ts`
Expected: PASS (5 + 2). Then `pnpm --filter dispatch-server exec tsc --noEmit` → clean.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/sessions/codex-sessions.ts packages/core/src/routes/sessions.ts packages/core/tests/sessions/codex-sessions.test.ts packages/core/tests/routes/codex-recent.test.ts
git commit -m "feat(core): recent-Codex-sessions lister + GET /api/sessions/:id/codex-recent"
```

---

### Task 2: Web — type, client, modal, and wiring

**Files:**
- Modify: `packages/web/src/api/types.ts` (add `CodexRecentSession`)
- Modify: `packages/web/src/api/client.ts` (add `recentCodexSessions` + import)
- Create: `packages/web/src/components/sidebar/NewCodexThreadModal.tsx`
- Modify: `packages/web/src/components/sidebar/NewTabMenu.tsx` (add `onPickCodex`)
- Modify: `packages/web/src/components/sidebar/ProjectCard.tsx` (state + render + wiring)
- Test: `packages/web/src/components/sidebar/NewCodexThreadModal.test.tsx`

**Interfaces:**
- Consumes: `GET /api/sessions/:id/codex-recent` (Task 1); `api.createTerminal(sessionId, { type:'codex', label?, externalId? })` (existing).
- Produces: `api.recentCodexSessions`; `CodexRecentSession`; `NewCodexThreadModal`.

- [ ] **Step 1: Add the web type**

In `packages/web/src/api/types.ts`, directly after the line `export interface CcRecentSession { … }`, add:

```ts
export interface CodexRecentSession { id: string; mtime: number; preview: string; messageCount: number; truncated: boolean; }
```

- [ ] **Step 2: Add the client method**

In `packages/web/src/api/client.ts`, add `CodexRecentSession` to the `import type { … } from './types'` line (alongside `CcRecentSession`). Then add, directly after the existing `recentCcSessions:` line:

```ts
  recentCodexSessions: (sessionId: string) => req<CodexRecentSession[]>(`/api/sessions/${sessionId}/codex-recent`),
```

- [ ] **Step 3: Write the modal test (failing)**

Create `packages/web/src/components/sidebar/NewCodexThreadModal.test.tsx`:

```tsx
import { render, screen, waitFor } from '@testing-library/react';
import { vi, test, expect } from 'vitest';

vi.mock('../common/Modal', () => ({ Modal: ({ title, children }: any) => <div>{title}{children}</div> }));
vi.mock('../../stores/tabs', () => ({ useTabs: { getState: () => ({ loadTabs: async () => {}, markLoading: () => {} }) } }));

const recentCodexSessions = vi.fn();
vi.mock('../../api/client', () => ({ api: {
  recentCodexSessions: (id: string) => recentCodexSessions(id),
  createTerminal: vi.fn(),
} }));

import { NewCodexThreadModal } from './NewCodexThreadModal';

test('shows new-thread action + recent resume rows', async () => {
  recentCodexSessions.mockResolvedValue([
    { id: 's1', mtime: Date.now() - 60000, preview: 'fix the build', messageCount: 12, truncated: false },
    { id: 's2', mtime: Date.now() - 3600000, preview: 'add dark mode', messageCount: 4, truncated: false },
  ]);
  render(<NewCodexThreadModal sessionId="proj1" onClose={() => {}} onCreated={() => {}} />);
  expect(screen.getByText('Start new thread')).toBeInTheDocument();
  await waitFor(() => expect(screen.getByText('fix the build')).toBeInTheDocument());
  expect(screen.getByText('add dark mode')).toBeInTheDocument();
});

test('no resume section when there are no recent sessions', async () => {
  recentCodexSessions.mockResolvedValue([]);
  render(<NewCodexThreadModal sessionId="proj1" onClose={() => {}} onCreated={() => {}} />);
  await waitFor(() => expect(recentCodexSessions).toHaveBeenCalled());
  expect(screen.queryByText('RESUME RECENT')).not.toBeInTheDocument();
  expect(screen.getByText('Start new thread')).toBeInTheDocument();
});
```

- [ ] **Step 4: Run to verify it fails**

Run: `pnpm --filter dispatch-web exec vitest run src/components/sidebar/NewCodexThreadModal.test.tsx`
Expected: FAIL — module `NewCodexThreadModal` not found.

- [ ] **Step 5: Create the modal**

Create `packages/web/src/components/sidebar/NewCodexThreadModal.tsx` (mirror of the Claude modal, adapted for Codex):

```tsx
import { useEffect, useState } from 'react';
import { Modal } from '../common/Modal';
import { Spinner } from '../common/Spinner';
import { api } from '../../api/client';
import { useTabs } from '../../stores/tabs';
import { timeAgo } from '../../lib/time';
import type { CodexRecentSession } from '../../api/types';

export function NewCodexThreadModal({ sessionId, onClose, onCreated }: { sessionId: string; onClose: () => void; onCreated: (id: string) => void }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [recent, setRecent] = useState<CodexRecentSession[] | null>(null);

  useEffect(() => {
    let on = true;
    api.recentCodexSessions(sessionId).then((r) => { if (on) setRecent(r); }).catch(() => { if (on) setRecent([]); });
    return () => { on = false; };
  }, [sessionId]);

  async function create(externalId?: string) {
    if (busy) return;
    setBusy(true);
    try {
      const t = await api.createTerminal(sessionId, { type: 'codex', label: name.trim() || undefined, externalId });
      await useTabs.getState().loadTabs(sessionId);
      useTabs.getState().markLoading(t.id);
      onCreated(t.id);
      onClose();
    } catch { setBusy(false); }
  }

  const input: React.CSSProperties = { height: 36, width: '100%', padding: '0 12px', background: 'var(--color-elevated)', border: '1px solid #2C2C32', borderRadius: 8, color: 'var(--color-text-primary)', fontSize: 14 };
  return (
    <Modal open onClose={onClose} title="New Codex Thread">
      <input autoFocus style={input} placeholder="Name (optional)" value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') void create(); }} />
      <button disabled={busy} onClick={() => void create()} style={{ marginTop: 12, height: 38, width: '100%', background: 'var(--color-accent)', border: 'none', borderRadius: 9, color: '#08240F', fontWeight: 600, fontSize: 14, cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.6 : 1 }}>Start new thread</button>

      {recent === null ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--color-text-tertiary)', fontSize: 13, marginTop: 18 }}><Spinner size={13} /> Loading recent sessions…</div>
      ) : recent.length > 0 ? (
        <div style={{ marginTop: 18 }}>
          <div style={{ font: '600 10px var(--font-mono)', letterSpacing: '1.2px', color: 'var(--color-text-tertiary)', marginBottom: 8 }}>RESUME RECENT</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 280, overflowY: 'auto' }}>
            {recent.map((s) => (
              <button key={s.id} disabled={busy} onClick={() => void create(s.id)}
                style={{ display: 'block', width: '100%', textAlign: 'left', background: 'var(--color-elevated)', border: '1px solid #2C2C32', borderRadius: 8, padding: '9px 11px', cursor: busy ? 'default' : 'pointer' }}>
                <div style={{ fontSize: 13, color: 'var(--color-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.preview}</div>
                <div style={{ marginTop: 3, font: '400 11px var(--font-mono)', color: 'var(--color-text-tertiary)' }}>{timeAgo(new Date(s.mtime).toISOString())} · {s.messageCount}{s.truncated ? '+' : ''} msg{s.messageCount === 1 ? '' : 's'}</div>
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </Modal>
  );
}
```

- [ ] **Step 6: Run modal tests**

Run: `pnpm --filter dispatch-web exec vitest run src/components/sidebar/NewCodexThreadModal.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 7: Wire the menu**

In `packages/web/src/components/sidebar/NewTabMenu.tsx`:
- Extend the prop signature to add `onPickCodex`:
  ```tsx
  export function NewTabMenu({ sessionId, onClose, onCreated, onPickClaude, onPickCodex }: { sessionId: string; onClose: () => void; onCreated?: (terminalId: string) => void; onPickClaude?: () => void; onPickCodex?: () => void }) {
  ```
- In `add()`, directly after the existing Claude redirect line (`if (t.type === 'claude-code' && onPickClaude) { onPickClaude(); return; }`), add:
  ```tsx
    if (t.type === 'codex' && onPickCodex) { onPickCodex(); return; }
  ```

- [ ] **Step 8: Wire ProjectCard**

In `packages/web/src/components/sidebar/ProjectCard.tsx`:
- Add the import after the `NewClaudeThreadModal` import (line ~18):
  ```tsx
  import { NewCodexThreadModal } from './NewCodexThreadModal';
  ```
- Add the state directly after `const [newClaude, setNewClaude] = useState(false);` (line ~286):
  ```tsx
  const [newCodex, setNewCodex] = useState(false);
  ```
- On the `NewTabMenu` at line ~422, add the `onPickCodex` prop (next to the existing `onPickClaude`):
  ```tsx
  {menu && <NewTabMenu sessionId={session.id} onClose={() => setMenu(false)} onCreated={onSelectTab} onPickClaude={() => { setMenu(false); setNewClaude(true); }} onPickCodex={() => { setMenu(false); setNewCodex(true); }} />}
  ```
- Add the modal render directly after the existing `{newClaude && ( … )}` block (lines ~548-550):
  ```tsx
  {newCodex && (
    <NewCodexThreadModal sessionId={session.id} onClose={() => setNewCodex(false)} onCreated={onSelectTab} />
  )}
  ```

- [ ] **Step 9: Typecheck, build, full web tests**

Run: `pnpm --filter dispatch-web exec tsc --noEmit && pnpm --filter dispatch-web build && pnpm --filter dispatch-web exec vitest run src/components/sidebar/NewCodexThreadModal.test.tsx`
Expected: tsc clean, build clean, modal tests pass.

- [ ] **Step 10: Commit**

```bash
git add packages/web/src/api/types.ts packages/web/src/api/client.ts packages/web/src/components/sidebar/NewCodexThreadModal.tsx packages/web/src/components/sidebar/NewTabMenu.tsx packages/web/src/components/sidebar/ProjectCard.tsx packages/web/src/components/sidebar/NewCodexThreadModal.test.tsx
git commit -m "feat(web): New Codex Thread modal (name + resume recent), wired into the new-thread menu"
```

---

## Self-Review

**1. Spec coverage:** lister + route (Task 1); type + client + modal + NewTabMenu/ProjectCard wiring + tests (Task 2); resume via existing `codex resume <id>` (externalId passed through `createTerminal`); no branch in modal. ✅
**2. Placeholder scan:** every step has complete code + exact commands. ✅
**3. Type consistency:** `RecentCodexSession` (core) and `CodexRecentSession` (web) share the exact field set of the Claude equivalents; `listRecentCodexSessions(workDir, limit?, root?)` consumed by the route; `api.recentCodexSessions` consumed by the modal; `onPickCodex` threaded NewTabMenu→ProjectCard. ✅
