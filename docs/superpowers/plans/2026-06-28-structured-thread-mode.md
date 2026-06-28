# Structured (stream-json) Claude Thread + Live View — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in "structured" transport for Claude threads — the daemon drives `claude` over the stream-json control protocol (auto-allowing permissions at parity with today), streams structured events to the web over a dedicated websocket, and View renders them live.

**Architecture:** A new `StructuredSessionManager` (parallel to `PTYManager`, NOT a replacement) owns one `claude` child process per structured terminal, runs the control loop (auto-allow), buffers + emits parsed events. A new structured websocket streams those events to the web; a new `/message` route feeds user turns. `spawnTerminal` branches on `config.transport === "structured"`. PTY threads are completely untouched (structured events are JSON, not raw bytes, so they intentionally do NOT share the PTY `'data'`/xterm/runner consumers).

**Tech Stack:** Node `child_process` + `readline` (NDJSON over stdio), `ws` (websocket), Express, better-sqlite3; React/Zustand web; vitest + supertest (core), vitest + @testing-library/react (web). Spec: `docs/superpowers/specs/2026-06-28-structured-thread-mode-design.md`.

## Global Constraints

- **ESM `.js` import specifiers** in all core imports.
- **Opt-in, alongside PTY, non-regressing:** existing PTY threads, the terminal ws, `writeToTerminal`, and the runner/`agentService` data path are UNCHANGED. Structured is selected only by `config.transport === "structured"` on a `claude-code` thread.
- **Parity permissions:** the control loop **auto-allows** every `control_request` (`{behavior:"allow", updatedInput:<echo of request.input>}`). It answers nothing else. A structured thread is exactly as autonomous as today.
- **Claude-only** this slice (Codex is a fast-follow). **Interrupt and human-answered prompts are deferred** to a later slice — slice 1 only spawns, streams, auto-allows, and sends user turns.
- **Spike-verified invocation (claude 2.1.195):** `claude -p --input-format stream-json --output-format stream-json --verbose --permission-mode default --permission-prompt-tool stdio`. The `--permission-prompt-tool stdio` flag is **undocumented** — pin the version + smoke-test it.
- **Subscription auth preserved:** spawn with the same inherited env as PTY (`apiKeySource:"none"`); no `ANTHROPIC_API_KEY`.
- **Top risk to verify early (Task 2):** multi-turn continuity — whether one long-lived process accepts multiple user turns over stdin (preferred) or must `--resume` per turn. The manager's `sendMessage` interface absorbs either.

## File structure

- Create `packages/core/src/structured/manager.ts` — `StructuredSessionManager` (the heart).
- Create `packages/core/tests/structured/manager.test.ts` + `packages/core/tests/structured/fake-claude.mjs` (hermetic stub).
- Modify `packages/core/src/providers/claude-code.ts` — add `buildStructuredCommand`.
- Modify `packages/core/src/sessions/service.ts` — `setStructuredManager`, `spawnTerminal` branch, `sendStructuredMessage`, structured kill on close.
- Modify `packages/core/src/routes/terminals.ts` — `POST /:id/message`.
- Create `packages/core/src/ws/structured.ts` — structured ws handler (mirror `ws/terminal.ts`).
- Modify `packages/core/src/server.ts` — construct + wire the manager, mount the ws (both `createApp` and `startServer`).
- Create `packages/web/src/api/structured-socket.ts` (mirror `api/terminal-socket.ts`).
- Modify `packages/web/src/api/client.ts` — `sendStructuredMessage`.
- Create `packages/web/src/components/tabs/useStructuredStream.ts` — events→`ConvItem[]` adapter hook.
- Modify `packages/web/src/components/tabs/ConversationView.tsx` — structured branch (ws stream + structured compose).
- Modify `packages/web/src/components/sidebar/NewTabMenu.tsx` — "Claude (structured)" option.

---

### Task 1: `StructuredSessionManager` (core) — driven by a fake `claude`

**Files:**
- Create: `packages/core/src/structured/manager.ts`
- Create: `packages/core/tests/structured/fake-claude.mjs`
- Test: `packages/core/tests/structured/manager.test.ts`

**Interfaces:**
- Produces:
  - `class StructuredSessionManager extends EventEmitter` with `spawn(terminalId: string, opts: { command: string; args: string[]; workDir: string; env?: Record<string,string> }): number` (returns child pid), `sendMessage(terminalId: string, text: string): void`, `kill(terminalId: string): void`, `isAlive(terminalId: string): boolean`, `getEvents(terminalId: string): unknown[]` (buffered events for replay).
  - Emits `'event'` `(terminalId: string, event: any)` for every parsed stdout line; `'exit'` `(terminalId: string, code: number)`.
  - Behavior: on a parsed `control_request` whose `request.subtype === 'can_use_tool'`, write an auto-allow `control_response` to the child stdin: `{type:'control_response', response:{subtype:'success', request_id, response:{behavior:'allow', updatedInput: request.input}}}`. `sendMessage` writes `{type:'user', message:{role:'user', content:text}}`. Each write is one line + `\n`.

- [ ] **Step 1: Write the fake `claude` stub**

```js
// packages/core/tests/structured/fake-claude.mjs
// A stand-in for `claude` in stream-json mode: emits NDJSON events and reacts to
// stdin control_responses / user turns. Lets us test the manager hermetically.
import readline from 'node:readline';
const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');
send({ type: 'system', subtype: 'init', apiKeySource: 'none', model: 'claude', session_id: 'sess-fake' });
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.type === 'user') {
    const text = msg.message?.content ?? '';
    if (text === 'TRIGGER_PERMISSION') {
      // ask permission; wait for the control_response, then report it
      send({ type: 'control_request', request_id: 'req-1', request: { subtype: 'can_use_tool', tool_name: 'Write', input: { file_path: 'x.txt', content: 'hi' }, tool_use_id: 'tu-1' } });
      return;
    }
    send({ type: 'assistant', message: { content: [{ type: 'text', text: 'echo:' + text }] } });
    send({ type: 'result', subtype: 'success', is_error: false });
  } else if (msg.type === 'control_response') {
    const allowed = msg.response?.response?.behavior === 'allow';
    send({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu-1', content: allowed ? 'WROTE' : 'DENIED' }] } });
    send({ type: 'result', subtype: 'success', is_error: false });
  }
});
```

- [ ] **Step 2: Write the failing test**

```ts
// packages/core/tests/structured/manager.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StructuredSessionManager } from '../../src/structured/manager.js';

const fake = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-claude.mjs');
const spawnFake = (m: StructuredSessionManager, id: string) =>
  m.spawn(id, { command: process.execPath, args: [fake], workDir: process.cwd() });

function waitForEvent(m: StructuredSessionManager, id: string, pred: (e: any) => boolean, timeoutMs = 3000): Promise<any> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { m.off('event', on); reject(new Error('timeout')); }, timeoutMs);
    const on = (eid: string, e: any) => { if (eid === id && pred(e)) { clearTimeout(t); m.off('event', on); resolve(e); } };
    m.on('event', on);
  });
}

let m: StructuredSessionManager;
beforeEach(() => { m = new StructuredSessionManager(); });
afterEach(() => { m.kill('t1'); });

it('spawns, emits parsed events, and buffers them', async () => {
  spawnFake(m, 't1');
  const init = await waitForEvent(m, 't1', (e) => e.type === 'system' && e.subtype === 'init');
  expect(init.apiKeySource).toBe('none');
  expect(m.isAlive('t1')).toBe(true);
  expect(m.getEvents('t1').some((e: any) => e.type === 'system')).toBe(true);
});

it('sendMessage writes a user turn and assistant events come back', async () => {
  spawnFake(m, 't1');
  await waitForEvent(m, 't1', (e) => e.type === 'system');
  m.sendMessage('t1', 'hello');
  const a = await waitForEvent(m, 't1', (e) => e.type === 'assistant');
  expect(JSON.stringify(a)).toContain('echo:hello');
});

it('auto-allows can_use_tool control_requests (parity)', async () => {
  spawnFake(m, 't1');
  await waitForEvent(m, 't1', (e) => e.type === 'system');
  m.sendMessage('t1', 'TRIGGER_PERMISSION');
  const result = await waitForEvent(m, 't1', (e) => e.type === 'user' && JSON.stringify(e).includes('WROTE'));
  expect(JSON.stringify(result)).toContain('WROTE'); // allowed, not DENIED
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd /Users/davidwebber/Sites/dispatch && pnpm --filter dispatch-server exec vitest run tests/structured/manager.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement `manager.ts`**

```ts
// packages/core/src/structured/manager.ts
import { EventEmitter } from 'node:events';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import readline from 'node:readline';

interface Session {
  child: ChildProcessWithoutNullStreams;
  events: unknown[]; // ring of recent events for replay
}

const MAX_EVENTS = 5000;

/**
 * Drives one `claude` stream-json process per structured terminal. Parallel to
 * PTYManager but its payload is structured JSON events (not raw bytes), so it has
 * its own consumers (the structured ws + the View adapter) — it does NOT feed the
 * xterm/runner data path. Permissions are auto-allowed (parity with today).
 */
export class StructuredSessionManager extends EventEmitter {
  private sessions = new Map<string, Session>();

  spawn(terminalId: string, opts: { command: string; args: string[]; workDir: string; env?: Record<string, string> }): number {
    if (this.sessions.has(terminalId)) this.kill(terminalId);
    const child = spawn(opts.command, opts.args, {
      cwd: opts.workDir,
      env: { ...process.env, ...opts.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams;
    const session: Session = { child, events: [] };
    this.sessions.set(terminalId, session);

    const rl = readline.createInterface({ input: child.stdout });
    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let event: any;
      try { event = JSON.parse(trimmed); } catch { return; } // skip non-JSON noise
      session.events.push(event);
      if (session.events.length > MAX_EVENTS) session.events.shift();
      // Auto-allow tool permission requests — parity with --dangerously-skip-permissions.
      if (event?.type === 'control_request' && event?.request?.subtype === 'can_use_tool') {
        this.write(terminalId, {
          type: 'control_response',
          response: { subtype: 'success', request_id: event.request_id, response: { behavior: 'allow', updatedInput: event.request.input } },
        });
      }
      this.emit('event', terminalId, event);
    });

    child.on('exit', (code) => {
      this.sessions.delete(terminalId);
      this.emit('exit', terminalId, code ?? 0);
    });
    child.on('error', (err) => { this.emit('event', terminalId, { type: 'system', subtype: 'spawn_error', message: String(err) }); });

    return child.pid ?? -1;
  }

  private write(terminalId: string, obj: unknown): void {
    const s = this.sessions.get(terminalId);
    if (!s || !s.child.stdin.writable) return;
    s.child.stdin.write(JSON.stringify(obj) + '\n');
  }

  sendMessage(terminalId: string, text: string): void {
    this.write(terminalId, { type: 'user', message: { role: 'user', content: text } });
  }

  kill(terminalId: string): void {
    const s = this.sessions.get(terminalId);
    if (!s) return;
    try { s.child.kill(); } catch { /* already gone */ }
    this.sessions.delete(terminalId);
  }

  isAlive(terminalId: string): boolean { return this.sessions.has(terminalId); }

  getEvents(terminalId: string): unknown[] { return this.sessions.get(terminalId)?.events ?? []; }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd /Users/davidwebber/Sites/dispatch && pnpm --filter dispatch-server exec vitest run tests/structured/manager.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
cd /Users/davidwebber/Sites/dispatch
git add packages/core/src/structured/manager.ts packages/core/tests/structured/
git commit -m "feat(structured): StructuredSessionManager (control loop + auto-allow + send) w/ fake-claude tests"
```

---

### Task 2: Verify multi-turn continuity against real `claude` (gating spike)

This de-risks the one load-bearing assumption before more is built on it: can one persistent process take a second user turn, or must we `--resume`?

**Files:** none committed (a throwaway check) — record the result in the report + a one-line code comment in `manager.ts`.

- [ ] **Step 1: Drive a real session for two turns**

In a temp dir, run the spike's persistent driver pattern (reference `/private/tmp/.../scratchpad/driver.py` from the stream-json spike, or a small node script using `StructuredSessionManager` with `command:'claude'` and the spike args): spawn one process, send user turn "say A", wait for its `result`, then send a second user turn "say B" on the **same** process. Observe whether the process accepts the second turn and emits a second assistant/`result`, or whether it exited after the first `result`.

Run: `cd /Users/davidwebber/Sites/dispatch && node <tmp-script>.mjs` (script spawns `claude -p --input-format stream-json --output-format stream-json --verbose --permission-mode default --permission-prompt-tool stdio`).

- [ ] **Step 2: Record the decision**

- If the process **stays alive and accepts turn 2** → persistent model confirmed; `sendMessage` (as written) is correct. Add a comment in `manager.ts`: `// verified: persistent multi-turn over stdin on claude <version>`.
- If it **exits after the first `result`** → switch `sendMessage` to **resume-per-turn**: capture `session_id` from the `init` event (store on `Session`), and on `sendMessage` re-`spawn` `claude --resume <session_id> -p …` with the new user turn. Keep the public interface identical. Add the comment + adjust Task 1's `manager.ts` accordingly (and a fake-claude variant test for the resume path).

- [ ] **Step 3: Commit (only if code changed)**

```bash
cd /Users/davidwebber/Sites/dispatch
git add packages/core/src/structured/manager.ts packages/core/tests/structured/
git commit -m "fix(structured): confirm/adjust multi-turn model (persistent vs resume) on pinned claude"
```
(If persistent was confirmed with no code change, skip the commit; just record it in the task report.)

---

### Task 3: `buildStructuredCommand` provider helper + version smoke test

**Files:**
- Modify: `packages/core/src/providers/claude-code.ts`
- Test: `packages/core/tests/providers/structured-command.test.ts`

**Interfaces:**
- Consumes: existing `SecretsMcpInjection`, `mcpArgs`, `systemPromptArgs` in `claude-code.ts`.
- Produces: `claudeCodeProvider.buildStructuredCommand({ workDir, secretsMcp }): { command: 'claude'; args: string[] }` — the spike flags + `--mcp-config`/`--append-system-prompt` injection. NOT `--dangerously-skip-permissions` (parity comes from the manager's auto-allow).

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/tests/providers/structured-command.test.ts
import { it, expect } from 'vitest';
import { claudeCodeProvider } from '../../src/providers/claude-code.js';

it('buildStructuredCommand emits the stream-json control-protocol flags', () => {
  const cmd = claudeCodeProvider.buildStructuredCommand!({ workDir: '/tmp' });
  expect(cmd.command).toBe('claude');
  const a = cmd.args.join(' ');
  expect(a).toContain('--input-format stream-json');
  expect(a).toContain('--output-format stream-json');
  expect(a).toContain('--permission-prompt-tool stdio');
  expect(a).toContain('--permission-mode default');
  expect(cmd.args).not.toContain('--dangerously-skip-permissions');
});

it('folds in mcp-config + system prompt when provided', () => {
  const cmd = claudeCodeProvider.buildStructuredCommand!({ workDir: '/tmp', secretsMcp: { claudeConfigPath: '/x/mcp.json', codexArgs: [], systemPrompt: 'note' } });
  expect(cmd.args).toContain('--mcp-config');
  expect(cmd.args).toContain('--append-system-prompt');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /Users/davidwebber/Sites/dispatch && pnpm --filter dispatch-server exec vitest run tests/providers/structured-command.test.ts`
Expected: FAIL — `buildStructuredCommand` undefined.

- [ ] **Step 3: Implement in `claude-code.ts`**

Add to the provider object (reuse the existing `mcpArgs` + `systemPromptArgs` helpers in that file):

```ts
buildStructuredCommand({ workDir, secretsMcp }: { workDir: string; secretsMcp?: SecretsMcpInjection }) {
  // The spike-verified stream-json control protocol. Parity permissions come from
  // the StructuredSessionManager's auto-allow loop, NOT --dangerously-skip-permissions.
  const args: string[] = [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--permission-mode', 'default',
    '--permission-prompt-tool', 'stdio',
    ...mcpArgs(secretsMcp),
    ...systemPromptArgs(secretsMcp),
  ];
  return { command: 'claude', args };
},
```
Add `buildStructuredCommand?` to the provider type in `packages/core/src/providers/types.ts` (optional method, Claude-only for now): `buildStructuredCommand?(opts: { workDir: string; secretsMcp?: SecretsMcpInjection }): { command: string; args: string[] }`.

- [ ] **Step 4: Add the version smoke test**

```ts
// append to tests/providers/structured-command.test.ts
import { execFileSync } from 'node:child_process';
it('pinned claude still accepts --permission-prompt-tool stdio (smoke)', () => {
  let help = '';
  try { help = execFileSync('claude', ['--help'], { encoding: 'utf8' }); } catch { return; } // skip if claude absent (CI)
  // The flag is intentionally undocumented; this asserts the binary at least runs and
  // is the expected CLI. The real guarantee is the manual run in the verification section.
  expect(help.toLowerCase()).toContain('claude');
});
```
(Note: `--permission-prompt-tool` is hidden from `--help`; the binding smoke check is the live round-trip in the Manual Verification section. This test just guards that `claude` is present + invokable.)

- [ ] **Step 5: Run + verify pass; commit**

Run: `cd /Users/davidwebber/Sites/dispatch && pnpm --filter dispatch-server exec vitest run tests/providers/structured-command.test.ts`
Expected: PASS.
```bash
git add packages/core/src/providers/claude-code.ts packages/core/src/providers/types.ts packages/core/tests/providers/structured-command.test.ts
git commit -m "feat(structured): buildStructuredCommand provider helper + version smoke test"
```

---

### Task 4: Wire into `SessionService` (spawn branch + send + close)

**Files:**
- Modify: `packages/core/src/sessions/service.ts`
- Test: covered by the route test in Task 6 (service wiring is exercised end-to-end there).

**Interfaces:**
- Consumes: `StructuredSessionManager` (Task 1), `buildStructuredCommand` (Task 3).
- Produces: `SessionService.setStructuredManager(m: StructuredSessionManager): void`; `SessionService.sendStructuredMessage(terminalId: string, text: string): void`. `spawnTerminal` branches on `config.transport === 'structured'`.

- [ ] **Step 1: Add the field + setter** (mirror the existing `setIntegrationsSpecs`/`setToolsAwareness` setters)

```ts
private structuredManager?: import('../structured/manager.js').StructuredSessionManager;
setStructuredManager(m: import('../structured/manager.js').StructuredSessionManager): void { this.structuredManager = m; }
```

- [ ] **Step 2: Branch in `spawnTerminal`**

Inside the non-shell `else` block, after `secretsMcp` is composed and BEFORE the existing `provider.buildResumeCommand/...` selection, add:

```ts
if (config.transport === 'structured' && terminal.type === 'claude-code' && this.structuredManager) {
  const sc = provider.buildStructuredCommand?.({ workDir, secretsMcp });
  if (!sc) throw new Error('structured transport not supported for this provider');
  const pid = this.structuredManager.spawn(terminalId, { command: sc.command, args: sc.args, workDir });
  terminalsDb.updatePid(this.db, terminalId, pid);
  return; // structured path complete — skip PTY spawn + session-id capture (no resume in slice 1)
}
```
(Place this right after `const secretsMcp = composeInjection(...)`. The existing PTY logic below stays unchanged for all other threads.)

- [ ] **Step 3: Add `sendStructuredMessage` + close handling**

```ts
sendStructuredMessage(terminalId: string, text: string): void {
  if (!this.structuredManager?.isAlive(terminalId)) throw new Error('no structured session for terminal');
  this.structuredManager.sendMessage(terminalId, text);
}
```
Find the terminal-close/remove path (where `this.ptyManager.kill(terminalId)` is called) and add `this.structuredManager?.kill(terminalId);` beside it so structured sessions are torn down on close.

- [ ] **Step 4: Typecheck**

Run: `cd /Users/davidwebber/Sites/dispatch && pnpm --filter dispatch-server exec tsc --noEmit`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/sessions/service.ts
git commit -m "feat(structured): SessionService spawn branch + sendStructuredMessage + close"
```

---

### Task 5: `POST /api/terminals/:id/message` route

**Files:**
- Modify: `packages/core/src/routes/terminals.ts`
- Test: `packages/core/tests/routes/structured.test.ts`

**Interfaces:** consumes `sessionService.sendStructuredMessage`.

- [ ] **Step 1: Write the failing route test** (real manager + the fake claude via a test seam)

```ts
// packages/core/tests/routes/structured.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import Database from 'better-sqlite3';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { initSchema } from '../../src/db/schema.js';
import { createApp } from '../../src/server.js';

const fake = path.join(path.dirname(fileURLToPath(import.meta.url)), '../structured/fake-claude.mjs');
let app: any; let db: Database.Database; let sessionId: string; let dir: string;
beforeEach(async () => {
  db = new Database(':memory:'); initSchema(db);
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'struct-'));
  // structuredCommand override makes the app spawn the fake instead of real claude (see Task 6 wiring)
  app = createApp({ db, skipPty: true, structuredCommand: { command: process.execPath, args: [fake] } });
  const s = await request(app).post('/api/sessions').send({ provider: 'claude-code', workingDir: dir, name: 't' });
  sessionId = s.body.id;
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

it('creates a structured thread and accepts a message', async () => {
  const t = await request(app).post(`/api/sessions/${sessionId}/terminals`).send({ type: 'claude-code', config: { transport: 'structured' } });
  expect(t.status).toBe(201);
  const msg = await request(app).post(`/api/terminals/${t.body.id}/message`).send({ text: 'hello' });
  expect(msg.status).toBe(204);
});

it('rejects a message with no text', async () => {
  const t = await request(app).post(`/api/sessions/${sessionId}/terminals`).send({ type: 'claude-code', config: { transport: 'structured' } });
  const res = await request(app).post(`/api/terminals/${t.body.id}/message`).send({});
  expect(res.status).toBe(400);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /Users/davidwebber/Sites/dispatch && pnpm --filter dispatch-server exec vitest run tests/routes/structured.test.ts`
Expected: FAIL (route + the `structuredCommand` test seam don't exist yet — added here + in Task 6).

- [ ] **Step 3: Add the route** (in `createTerminalsRouter`, beside `/input`)

```ts
router.post('/terminals/:terminalId/message', (req, res) => {
  const text = req.body?.text;
  if (typeof text !== 'string' || !text) return res.status(400).json({ error: 'text (string) is required' });
  try { sessionService.sendStructuredMessage(req.params.terminalId, text); res.status(204).end(); }
  catch (e: any) { res.status(400).json({ error: e?.message ?? String(e) }); }
});
```

- [ ] **Step 4: Run after Task 6 wiring** (this test needs the Task 6 server wiring + the `structuredCommand` seam). Note in the task report that Tasks 5 + 6 land together (the route + the wiring) and the test goes green after Task 6.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/routes/terminals.ts packages/core/tests/routes/structured.test.ts
git commit -m "feat(structured): POST /terminals/:id/message route + route test"
```

---

### Task 6: Server wiring + structured websocket

**Files:**
- Create: `packages/core/src/ws/structured.ts` (mirror `ws/terminal.ts`)
- Modify: `packages/core/src/server.ts` (construct manager, inject test command, mount ws — in BOTH `createApp` and `startServer`)

**Interfaces:**
- Consumes: `StructuredSessionManager`, `sessionService`.
- Produces: `handleStructuredConnection(ws, req, manager)` — on connect, replays `manager.getEvents(id)` as JSON frames then streams live `'event'`s; the `structuredCommand` option seam so tests spawn the fake.

- [ ] **Step 1: Implement the ws handler** (mirror `ws/terminal.ts:21-96`)

```ts
// packages/core/src/ws/structured.ts
import type { WebSocket } from 'ws';
import type { IncomingMessage } from 'node:http';
import type { StructuredSessionManager } from '../structured/manager.js';

export function handleStructuredConnection(ws: WebSocket, req: IncomingMessage, manager: StructuredSessionManager): void {
  const m = req.url?.match(/\/api\/terminals\/([^/]+)\/structured-ws/);
  const id = m?.[1];
  if (!id) { ws.close(4000, 'Invalid URL'); return; }
  // Replay buffered events, then stream live.
  for (const e of manager.getEvents(id)) { if (ws.readyState === 1) ws.send(JSON.stringify(e)); }
  const onEvent = (eid: string, event: unknown) => { if (eid === id && ws.readyState === 1) ws.send(JSON.stringify(event)); };
  manager.on('event', onEvent);
  ws.on('close', () => manager.off('event', onEvent));
}
```

- [ ] **Step 2: Wire `createApp`** (mirror where `ptyManager`/services are built, ~server.ts:88-133)

- Add `structuredCommand?: { command: string; args: string[] }` to `CreateAppOptions` (the test seam).
- Construct `const structuredManager = new StructuredSessionManager();` and `sessionService.setStructuredManager(structuredManager);`.
- If `options.structuredCommand` is set, the provider should use it: simplest seam — store it on the service via a setter `setStructuredCommandOverride(cmd)` that `spawnTerminal`'s structured branch uses instead of `buildStructuredCommand` when present. Add that small override (3 lines) so the route test spawns the fake. Attach `(app as any)._structuredManager = structuredManager;`.

- [ ] **Step 3: Wire `startServer`** (~server.ts:202-363)

- `const structuredManager = new StructuredSessionManager(); sessionService.setStructuredManager(structuredManager);`
- Add a `structuredWss = new WebSocketServer({ noServer: true });`
- In the `upgrade` handler, add a branch BEFORE the terminal-ws branch:
  ```ts
  if (url.match(/\/api\/terminals\/[^/]+\/structured-ws/)) {
    structuredWss.handleUpgrade(request, socket, head, (ws) => handleStructuredConnection(ws, request, structuredManager));
  } else if (url.match(/\/api\/terminals\/[^/]+\/ws/) || ...) { /* existing */ }
  ```
  (Order matters — the structured pattern is more specific; match it first.)

- [ ] **Step 4: Run the Task 5 route test + full core suite + tsc**

Run:
```
cd /Users/davidwebber/Sites/dispatch
pnpm --filter dispatch-server exec vitest run tests/routes/structured.test.ts
pnpm --filter dispatch-server exec vitest run
pnpm --filter dispatch-server exec tsc --noEmit
```
Expected: structured route test green; full suite green; tsc clean.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/ws/structured.ts packages/core/src/server.ts
git commit -m "feat(structured): structured websocket + server wiring (createApp + startServer)"
```

---

### Task 7: Web — structured socket client + events→items adapter + View branch

**Files:**
- Create: `packages/web/src/api/structured-socket.ts` (mirror `api/terminal-socket.ts`)
- Modify: `packages/web/src/api/client.ts` (`sendStructuredMessage`)
- Create: `packages/web/src/components/tabs/useStructuredStream.ts`
- Modify: `packages/web/src/components/tabs/ConversationView.tsx`
- Test: `packages/web/src/components/tabs/useStructuredStream.test.ts`

**Interfaces:**
- Produces: `openStructuredSocket({ terminalId, onEvent, onReset?, onClose? })` (mirror `openTerminalSocket`, but `onmessage` → `onEvent(JSON.parse(ev.data))`); `api.sendStructuredMessage(id, text)`; `useStructuredStream(terminalId): ConvItem[]` (subscribes, maps events → `ConvItem[]`).
- Event→`ConvItem` mapping: `assistant` text block → `{kind:'assistant', text}`; `assistant` thinking block → `{kind:'thinking', text}`; `assistant` tool_use block → `{kind:'tool', toolName, toolInput: JSON.stringify(input), toolFile?}`; `user` tool_result block → `{kind:'tool-result', text, isError}`. (Matches the `ConvItem` shape the existing renderers already consume.)

- [ ] **Step 1: Write the failing adapter test**

```ts
// packages/web/src/components/tabs/useStructuredStream.test.ts
import { renderHook, act } from '@testing-library/react';
import { test, expect, vi } from 'vitest';
import { useStructuredStream } from './useStructuredStream';
import * as sock from '../../api/structured-socket';

test('maps structured events into ConvItems', () => {
  let emit!: (e: any) => void;
  vi.spyOn(sock, 'openStructuredSocket').mockImplementation(({ onEvent }: any) => { emit = onEvent; return { close: () => {} }; });
  const { result } = renderHook(() => useStructuredStream('t1'));
  act(() => emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } }));
  act(() => emit({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] } }));
  const items = result.current;
  expect(items.find((i) => i.kind === 'assistant' && i.text === 'hi')).toBeTruthy();
  expect(items.find((i) => i.kind === 'tool' && i.toolName === 'Bash')).toBeTruthy();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /Users/davidwebber/Sites/dispatch && pnpm --filter dispatch-web exec vitest run src/components/tabs/useStructuredStream.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement `structured-socket.ts`** — copy `api/terminal-socket.ts` verbatim, rename `openTerminalSocket`→`openStructuredSocket`, change the url to `/api/terminals/${id}/structured-ws`, replace the `onData(chunk)` option with `onEvent(event)` and set `sock.onmessage = (ev) => { try { opts.onEvent(JSON.parse(ev.data)); } catch {} }`. Drop the `resize`/`send` returns (not needed); keep `close` + reconnect/backoff.

- [ ] **Step 4: Implement `useStructuredStream.ts`**

```tsx
import { useEffect, useRef, useState } from 'react';
import type { ConvItem } from '../../api/types';
import { openStructuredSocket } from '../../api/structured-socket';

function toItems(event: any): ConvItem[] {
  const out: ConvItem[] = [];
  if (event?.type === 'assistant' && Array.isArray(event.message?.content)) {
    for (const b of event.message.content) {
      if (b.type === 'text' && b.text) out.push({ kind: 'assistant', text: b.text });
      else if (b.type === 'thinking') out.push({ kind: 'thinking', text: b.thinking ?? b.text ?? '' });
      else if (b.type === 'tool_use') out.push({ kind: 'tool', toolName: b.name, toolInput: safeJson(b.input), toolFile: b.input?.file_path ?? b.input?.path });
    }
  } else if (event?.type === 'user' && Array.isArray(event.message?.content)) {
    for (const b of event.message.content) {
      if (b.type === 'tool_result') out.push({ kind: 'tool-result', text: typeof b.content === 'string' ? b.content : JSON.stringify(b.content), isError: b.is_error === true });
    }
  }
  return out;
}
function safeJson(v: unknown): string { try { return JSON.stringify(v, null, 2); } catch { return String(v); } }

export function useStructuredStream(terminalId: string): ConvItem[] {
  const [items, setItems] = useState<ConvItem[]>([]);
  const ref = useRef<{ close: () => void } | null>(null);
  useEffect(() => {
    setItems([]);
    const sock = openStructuredSocket({ terminalId, onEvent: (e) => { const mapped = toItems(e); if (mapped.length) setItems((prev) => [...prev, ...mapped]); }, onReset: () => setItems([]) });
    ref.current = sock;
    return () => sock.close();
  }, [terminalId]);
  return items;
}
```

- [ ] **Step 5: Add `api.sendStructuredMessage`** to `client.ts` (beside `sendInput`):

```ts
sendStructuredMessage: (id: string, text: string) => req<void>(`/api/terminals/${id}/message`, { method: 'POST', body: body({ text }) }),
```

- [ ] **Step 6: Branch `ConversationView` for structured threads**

In `ConversationView`, read the tab (`findTerminal`) and detect structured: `const structured = (tab?.config as any)?.transport === 'structured';`. When `structured`:
- use `const liveItems = useStructuredStream(terminalId)` and render `liveItems` instead of the polled `items` (skip the poll `useEffect`/`loadInitial` when structured — guard them with `if (structured) return;`).
- the compose `sendToTerminal` → instead call `void api.sendStructuredMessage(terminalId, v)` and clear; do NOT switch to Terminal mode.
Keep all existing rendering (Item/ToolCall/rich tool-views) — they consume `ConvItem` either way.

- [ ] **Step 7: Run the adapter test + full web suite + tsc + build**

Run:
```
cd /Users/davidwebber/Sites/dispatch
pnpm --filter dispatch-web exec vitest run src/components/tabs/useStructuredStream.test.ts
pnpm --filter dispatch-web exec vitest run
pnpm --filter dispatch-web exec tsc --noEmit
pnpm --filter dispatch-web build
```
Expected: PASS; tsc clean; build OK.

- [ ] **Step 8: Commit**

```bash
git add packages/web/src/api/structured-socket.ts packages/web/src/api/client.ts packages/web/src/components/tabs/useStructuredStream.ts packages/web/src/components/tabs/useStructuredStream.test.ts packages/web/src/components/tabs/ConversationView.tsx
git commit -m "feat(web): structured socket + events→items adapter + ConversationView live structured render"
```

---

### Task 8: Web — "Claude (structured)" creation option

**Files:**
- Modify: `packages/web/src/components/sidebar/NewTabMenu.tsx`
- Test: `packages/web/src/components/sidebar/NewTabMenu.test.tsx` (extend, or create)

**Interfaces:** consumes `api.createTerminal(sessionId, { type, config })`.

- [ ] **Step 1: Write the failing test**

```tsx
// in NewTabMenu.test.tsx
import { render, screen } from '@testing-library/react';
import { test, expect } from 'vitest';
import { NewTabMenu } from './NewTabMenu';

test('offers a Claude (structured) option', () => {
  render(<NewTabMenu sessionId="s1" onClose={() => {}} />);
  expect(screen.getByText(/Claude \(structured\)/i)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /Users/davidwebber/Sites/dispatch && pnpm --filter dispatch-web exec vitest run src/components/sidebar/NewTabMenu.test.tsx`
Expected: FAIL — no such option.

- [ ] **Step 3: Add the option**

In `NewTabMenu.tsx`, add to `TYPES`:
```ts
{ type: 'claude-code', label: 'Claude (structured)', config: { transport: 'structured' } },
```
The existing `add()` already forwards `config` to `api.createTerminal`. Ensure the structured entry does NOT route through `onPickClaude` (which opens the name/resume modal) — give it a distinct `type` key in the menu list or special-case it in `add()` so it creates directly with the config (e.g. check `t.config?.transport === 'structured'` and create directly instead of calling `onPickClaude`).

- [ ] **Step 4: Run + verify pass; full web suite + build**

Run:
```
cd /Users/davidwebber/Sites/dispatch
pnpm --filter dispatch-web exec vitest run src/components/sidebar/NewTabMenu.test.tsx
pnpm --filter dispatch-web exec vitest run
pnpm --filter dispatch-web build
```
Expected: PASS; build OK.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/components/sidebar/NewTabMenu.tsx packages/web/src/components/sidebar/NewTabMenu.test.tsx
git commit -m "feat(web): New Tab menu — Claude (structured) option"
```

---

## Manual verification (after Task 8; requires the daemon restarted onto new core)

This adds core routes + ws + spawn branch, so go live with `pnpm --filter dispatch-server build && ./bin/dispatch restart` (ends the session). Then:
1. **Hidden-flag + multi-turn (the load-bearing checks):** create a "Claude (structured)" thread; confirm it streams events live in View (init → assistant → result), send a follow-up message, confirm the **second turn works** (validates Task 2's model on the live daemon).
2. **Parity autonomy:** ask it to create a file / run a command; confirm tools run **without prompting** (auto-allow), exactly like a PTY thread.
3. **Live render quality:** confirm assistant text, thinking, and the rich tool-views (query/diff/todo) render live with no poll lag.
4. **Non-regression:** confirm existing PTY claude/codex threads are unchanged (Terminal + their View both work).

## Self-Review notes (plan author)

- **Spec coverage:** structured transport alongside PTY (Tasks 1,4); parity auto-allow (Task 1); buildStructuredCommand + flags + smoke test (Task 3); spawn branch + send + close (Task 4); message route (Task 5); structured ws + server wiring (Task 6); live View from stream + adapter + structured compose (Task 7); creation option (Task 8); multi-turn risk gated (Task 2); undocumented-flag risk (Task 3 smoke + manual). Interrupt + human-answered prompts explicitly deferred (Global Constraints) — matches the spec's "later slices."
- **Type consistency:** `StructuredSessionManager` (spawn/sendMessage/kill/isAlive/getEvents/events 'event'+'exit'), `buildStructuredCommand`, `setStructuredManager`/`sendStructuredMessage`, `handleStructuredConnection`, `openStructuredSocket`/`onEvent`, `useStructuredStream`, `config.transport:"structured"` — used identically across tasks.
- **Known coupling:** Tasks 5 + 6 land together (the route needs the server wiring + `structuredCommand` test seam) — flagged in Task 5 Step 4.
