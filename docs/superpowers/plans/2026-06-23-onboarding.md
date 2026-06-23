# Dispatch Onboarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a developer self-host Dispatch on a fresh Mac and reach it from their phone via one paste plus a short, skippable first-run wizard (Agents → Tailscale → Doppler), backed by shared detection that also powers a `dispatch doctor` CLI.

**Architecture:** A pure detection module in `packages/core` is consumed by new `/api/setup/*` routes and the `dispatch doctor` CLI. The web app gates a `SetupWizard` overlay on a server `firstRun` flag (persisted in the existing `app_state` kv table) and reuses the existing Doppler Settings UI for the secrets step. A hardened bootstrap `install.sh` makes the whole thing a one-liner.

**Tech Stack:** Node 18+/TypeScript (ESM, `.js` import specifiers), Express, better-sqlite3, vitest + supertest (core), React/Vite/Zustand + vitest + @testing-library/react (web), bash + launchd (CLI/installer).

## Global Constraints

- ESM only; **import specifiers end in `.js`** even for `.ts` sources (e.g. `import { get } from '../db/app-state.js'`).
- Detection must **never throw to the client**: missing binary → `installed:false`; failure/timeout → `signedIn:'unknown'` / `running:false`. `tailscale status` is bounded to a **2000 ms** timeout.
- Mobile access is **Tailscale-only**; add **no** public listener.
- Secrets never leave the server (existing Doppler 0600 `~/.dispatch/doppler.json` behavior is unchanged).
- Daemon default port: `Number(process.env.PORT) || 3456`.
- Routes are mounted in **both** `createApp` (~line 90-100) and `startServer` (~line 276-287) in `packages/core/src/server.ts`.
- Core tests: `pnpm --filter dispatch-server exec vitest run`. Web tests: `pnpm --filter dispatch-web exec vitest run`. Typecheck: `pnpm --filter <pkg> exec tsc --noEmit`.
- Wizard install location for the installer: `~/.dispatch/app`.
- Commit after every task. Do not push unless asked.

## File Structure

- `packages/core/src/setup/detect.ts` — pure detection (providers, tailscale). **New.**
- `packages/core/src/routes/setup.ts` — `/api/setup/*` routes; composes state from detect + `app_state` + `SecretsService`. **New.**
- `packages/core/src/server.ts` — mount the setup router (both apps). **Modify.**
- `packages/core/tests/setup/detect.test.ts` — unit tests for detect. **New.**
- `packages/core/tests/routes/setup.test.ts` — route shape tests. **New.**
- `bin/dispatch` — add `doctor` subcommand. **Modify.**
- `packages/web/src/api/types.ts` — setup types. **Modify.**
- `packages/web/src/api/client.ts` — setup API calls. **Modify.**
- `packages/web/src/stores/setup.ts` — wizard visibility store. **New.**
- `packages/web/src/components/setup/SetupWizard.tsx` — overlay + steps. **New.**
- `packages/web/src/components/setup/SetupWizard.test.tsx` — wizard tests. **New.**
- `packages/web/src/App.tsx` — mount `<SetupWizard/>`. **Modify.**
- `packages/web/src/components/settings/SettingsModal.tsx` — "Getting started" re-entry button. **Modify.**
- `scripts/install.sh` — bootstrap clone+build+install (one-liner). **Modify.**
- `README.md` / `docs/providers.md` — install one-liner + public-repo note. **Modify.**

---

## Phase 1 — Detection core + state endpoint + CLI doctor

### Task 1: Shared detection module

**Files:**
- Create: `packages/core/src/setup/detect.ts`
- Test: `packages/core/tests/setup/detect.test.ts`

**Interfaces:**
- Produces:
  - `interface ProviderStatus { name: 'claude' | 'codex'; installed: boolean; version?: string; signedIn: boolean | 'unknown' }`
  - `interface TailscaleStatus { installed: boolean; running: boolean; dnsName?: string; url?: string }`
  - `detectProvider(name: 'claude' | 'codex'): Promise<ProviderStatus>`
  - `detectAllProviders(): Promise<ProviderStatus[]>`
  - `detectTailscale(port: number): Promise<TailscaleStatus>`

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/tests/setup/detect.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock node:child_process execFile BEFORE importing the module under test.
const execFileMock = vi.fn();
vi.mock('node:child_process', () => ({ execFile: (...args: any[]) => execFileMock(...args) }));
vi.mock('node:fs', () => ({ existsSync: (p: string) => fsExists(p) }));

let fsExists: (p: string) => boolean = () => false;

// promisify(execFile) calls execFile(cmd, args, opts, cb). Emulate that contract.
function whenExec(impl: (cmd: string, args: string[]) => { stdout: string } | Error) {
  execFileMock.mockImplementation((cmd: string, args: string[], _opts: any, cb: any) => {
    const r = impl(cmd, args);
    if (r instanceof Error) cb(r); else cb(null, { stdout: r.stdout, stderr: '' });
  });
}

import { detectProvider, detectTailscale } from '../../src/setup/detect.js';

describe('detectProvider', () => {
  beforeEach(() => { execFileMock.mockReset(); fsExists = () => false; });

  it('reports not installed when the binary is absent', async () => {
    whenExec((cmd) => cmd === 'which' ? new Error('not found') : { stdout: '' });
    const r = await detectProvider('claude');
    expect(r).toEqual({ name: 'claude', installed: false, signedIn: false });
  });

  it('reports installed + signedIn when binary and creds exist', async () => {
    fsExists = (p) => p.endsWith('/.claude') || p.endsWith('/.credentials.json');
    whenExec((cmd, args) => {
      if (cmd === 'which') return { stdout: '/usr/local/bin/claude\n' };
      if (args.includes('--version')) return { stdout: 'claude 1.2.3\n' };
      return { stdout: '' };
    });
    const r = await detectProvider('claude');
    expect(r.installed).toBe(true);
    expect(r.version).toBe('claude 1.2.3');
    expect(r.signedIn).toBe(true);
  });

  it('signedIn is "unknown" when installed but no creds file', async () => {
    fsExists = (p) => p.endsWith('/.claude'); // dir exists, no creds file
    whenExec((cmd) => cmd === 'which' ? { stdout: '/usr/local/bin/claude\n' } : { stdout: '' });
    const r = await detectProvider('claude');
    expect(r.signedIn).toBe('unknown');
  });
});

describe('detectTailscale', () => {
  beforeEach(() => { execFileMock.mockReset(); fsExists = () => false; });

  it('not installed when binary missing and app bundle absent', async () => {
    whenExec((cmd) => cmd === 'which' ? new Error('nope') : { stdout: '' });
    const r = await detectTailscale(3456);
    expect(r).toEqual({ installed: false, running: false });
  });

  it('builds the URL from MagicDNS when running', async () => {
    whenExec((cmd, args) => {
      if (cmd === 'which') return { stdout: '/usr/bin/tailscale\n' };
      if (args.includes('status')) return { stdout: JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'my-mac.tailnet.ts.net.' } }) };
      return { stdout: '' };
    });
    const r = await detectTailscale(3456);
    expect(r).toEqual({ installed: true, running: true, dnsName: 'my-mac.tailnet.ts.net', url: 'http://my-mac.tailnet.ts.net:3456' });
  });

  it('running:false (no url) when stopped', async () => {
    whenExec((cmd, args) => {
      if (cmd === 'which') return { stdout: '/usr/bin/tailscale\n' };
      if (args.includes('status')) return { stdout: JSON.stringify({ BackendState: 'Stopped', Self: { DNSName: 'x.ts.net.' } }) };
      return { stdout: '' };
    });
    const r = await detectTailscale(3456);
    expect(r.installed).toBe(true);
    expect(r.running).toBe(false);
    expect(r.url).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter dispatch-server exec vitest run tests/setup/detect.test.ts`
Expected: FAIL — `Cannot find module '../../src/setup/detect.js'`.

- [ ] **Step 3: Write the implementation**

```ts
// packages/core/src/setup/detect.ts
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const exec = promisify(execFile);

export interface ProviderStatus { name: 'claude' | 'codex'; installed: boolean; version?: string; signedIn: boolean | 'unknown'; }
export interface TailscaleStatus { installed: boolean; running: boolean; dnsName?: string; url?: string; }

async function which(bin: string): Promise<string | null> {
  try { const { stdout } = await exec('which', [bin]); return stdout.trim() || null; }
  catch { return null; }
}

function detectSignedIn(name: 'claude' | 'codex'): boolean | 'unknown' {
  const home = os.homedir();
  try {
    if (name === 'claude') {
      const dir = path.join(home, '.claude');
      if (!existsSync(dir)) return false;
      if (['.credentials.json', 'credentials.json'].some((f) => existsSync(path.join(dir, f)))) return true;
      return 'unknown';
    }
    const dir = path.join(home, '.codex');
    if (!existsSync(dir)) return false;
    if (existsSync(path.join(dir, 'auth.json'))) return true;
    return 'unknown';
  } catch { return 'unknown'; }
}

export async function detectProvider(name: 'claude' | 'codex'): Promise<ProviderStatus> {
  const bin = await which(name);
  if (!bin) return { name, installed: false, signedIn: false };
  let version: string | undefined;
  try { const { stdout } = await exec(name, ['--version'], { timeout: 4000 }); version = stdout.trim().split('\n')[0] || undefined; }
  catch { /* version is best-effort */ }
  return { name, installed: true, version, signedIn: detectSignedIn(name) };
}

export async function detectAllProviders(): Promise<ProviderStatus[]> {
  return Promise.all([detectProvider('claude'), detectProvider('codex')]);
}

const TS_APP_BIN = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';

export async function detectTailscale(port: number): Promise<TailscaleStatus> {
  let bin = await which('tailscale');
  if (!bin && existsSync(TS_APP_BIN)) bin = TS_APP_BIN;
  if (!bin) return { installed: false, running: false };
  try {
    const { stdout } = await exec(bin, ['status', '--json'], { timeout: 2000 });
    const data = JSON.parse(stdout);
    const dnsName = data?.Self?.DNSName ? String(data.Self.DNSName).replace(/\.$/, '') : undefined;
    const running = data?.BackendState === 'Running';
    const url = running && dnsName ? `http://${dnsName}:${port}` : undefined;
    return { installed: true, running, dnsName, url };
  } catch { return { installed: true, running: false }; }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter dispatch-server exec vitest run tests/setup/detect.test.ts`
Expected: PASS (6 tests). Then `pnpm --filter dispatch-server exec tsc --noEmit` → no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/setup/detect.ts packages/core/tests/setup/detect.test.ts
git commit -m "feat(core): setup detection module (providers + tailscale)"
```

---

### Task 2: `/api/setup/*` routes + firstRun persistence

**Files:**
- Create: `packages/core/src/routes/setup.ts`
- Modify: `packages/core/src/server.ts` (mount in createApp ~L100 and startServer ~L287)
- Test: `packages/core/tests/routes/setup.test.ts`

**Interfaces:**
- Consumes: `detectAllProviders`, `detectTailscale` (Task 1); `app_state.get/set` (`packages/core/src/db/app-state.js`); `SecretsService.status()`.
- Produces: `createSetupRouter(db: Database.Database, secrets: SecretsService): Router`. Endpoints:
  - `GET /api/setup/state` → `{ firstRun: boolean; providers: ProviderStatus[]; tailscale: TailscaleStatus; secrets: { connected: boolean } }`
  - `GET /api/setup/providers` → `ProviderStatus[]`
  - `GET /api/setup/tailscale` → `TailscaleStatus`
  - `POST /api/setup/complete` → `{ ok: true }`

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/tests/routes/setup.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import { createApp } from '../../src/server.js';

// Detection hits the real filesystem/PATH otherwise — stub it for deterministic shapes.
vi.mock('../../src/setup/detect.js', () => ({
  detectAllProviders: async () => ([{ name: 'claude', installed: true, signedIn: true }, { name: 'codex', installed: false, signedIn: false }]),
  detectTailscale: async () => ({ installed: false, running: false }),
}));

describe('setup routes', () => {
  let app: any; let db: any;
  beforeEach(() => { db = new Database(':memory:'); initSchema(db); app = createApp({ db, skipPty: true }); });

  it('reports firstRun true before completion', async () => {
    const res = await request(app).get('/api/setup/state');
    expect(res.status).toBe(200);
    expect(res.body.firstRun).toBe(true);
    expect(res.body.providers).toHaveLength(2);
    expect(res.body.secrets).toEqual({ connected: false });
  });

  it('POST /complete flips firstRun to false', async () => {
    await request(app).post('/api/setup/complete').expect(200);
    const res = await request(app).get('/api/setup/state');
    expect(res.body.firstRun).toBe(false);
  });

  it('GET /providers returns the provider array', async () => {
    const res = await request(app).get('/api/setup/providers');
    expect(res.status).toBe(200);
    expect(res.body[0].name).toBe('claude');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter dispatch-server exec vitest run tests/routes/setup.test.ts`
Expected: FAIL — 404s (router not mounted).

- [ ] **Step 3: Write the router**

```ts
// packages/core/src/routes/setup.ts
import { Router } from 'express';
import type Database from 'better-sqlite3';
import * as appState from '../db/app-state.js';
import type { SecretsService } from '../secrets/service.js';
import { detectAllProviders, detectTailscale } from '../setup/detect.js';

const SETUP_KEY = 'setup_completed_at';
const port = () => Number(process.env.PORT) || 3456;

export function createSetupRouter(db: Database.Database, secrets: SecretsService): Router {
  const router = Router();

  router.get('/state', async (_req, res) => {
    const [providers, tailscale] = await Promise.all([detectAllProviders(), detectTailscale(port())]);
    res.json({
      firstRun: appState.get(db, SETUP_KEY) === null,
      providers,
      tailscale,
      secrets: { connected: secrets.status().connected },
    });
  });

  router.get('/providers', async (_req, res) => res.json(await detectAllProviders()));
  router.get('/tailscale', async (_req, res) => res.json(await detectTailscale(port())));
  router.post('/complete', (_req, res) => { appState.set(db, SETUP_KEY, new Date().toISOString()); res.json({ ok: true }); });

  return router;
}
```

- [ ] **Step 4: Mount the router in both apps**

In `packages/core/src/server.ts`, add the import near the other route imports:

```ts
import { createSetupRouter } from './routes/setup.js';
```

In `createApp` (after the `/api/secrets` line ~L96) add:

```ts
  app.use('/api/setup', createSetupRouter(db, secretsService));
```

In `startServer` (after its `/api/secrets` line ~L282) add the identical line:

```ts
  app.use('/api/setup', createSetupRouter(db, secretsService));
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter dispatch-server exec vitest run tests/routes/setup.test.ts`
Expected: PASS (3 tests). Then `pnpm --filter dispatch-server exec tsc --noEmit`.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/routes/setup.ts packages/core/src/server.ts packages/core/tests/routes/setup.test.ts
git commit -m "feat(core): /api/setup state/providers/tailscale/complete routes"
```

---

### Task 3: `dispatch doctor` CLI subcommand

**Files:**
- Modify: `bin/dispatch` (add `cmd_doctor`, a `doctor)` case, and a usage line)

**Interfaces:**
- Consumes: `GET http://localhost:$PORT/api/setup/state` (Task 2). Requires `python3` (preinstalled on macOS) for JSON parsing in bash, matching no new deps.

- [ ] **Step 1: Add the `cmd_doctor` function**

Add this function in `bin/dispatch` just above the usage block (near `cmd_status`):

```bash
cmd_doctor() {
  if ! curl -fsS -m 5 "http://localhost:$PORT/api/setup/state" -o /tmp/dispatch-setup.json 2>/dev/null; then
    red "Daemon not reachable on :$PORT — run: dispatch status"
    exit 1
  fi
  bold "Dispatch setup status"
  python3 - "$PORT" <<'PY'
import json, sys
port = sys.argv[1]
d = json.load(open('/tmp/dispatch-setup.json'))
def mark(ok): return '\033[32m✓\033[0m' if ok else '\033[31m✗\033[0m'
for p in d.get('providers', []):
    signed = p.get('signedIn')
    s = 'signed in' if signed is True else ('unknown' if signed == 'unknown' else 'signed out')
    print(f"  {mark(p.get('installed'))} {p['name']:7} {'installed' if p.get('installed') else 'not found'} · {s}")
ts = d.get('tailscale', {})
if ts.get('running') and ts.get('url'):
    print(f"  {mark(True)} tailscale  reachable at {ts['url']}")
else:
    print(f"  {mark(False)} tailscale  {'installed, not running' if ts.get('installed') else 'not installed'}")
print(f"  {mark(d.get('secrets',{}).get('connected'))} doppler    {'connected' if d.get('secrets',{}).get('connected') else 'not connected (optional)'}")
PY
}
```

- [ ] **Step 2: Add the case + usage line**

In the `case "${1:-}" in` block, add before the `*)` line:

```bash
  doctor)    cmd_doctor ;;
```

And add to the usage text (near the other `dispatch <cmd>` lines):

```bash
  dispatch doctor      Show setup status (agents, tailscale, secrets)
```

- [ ] **Step 3: Verify manually**

Run: `./bin/dispatch doctor`
Expected: a colored checklist of claude/codex/tailscale/doppler. (Requires the daemon running; if not, prints the "not reachable" message and exits 1.)

- [ ] **Step 4: Commit**

```bash
git add bin/dispatch
git commit -m "feat(cli): dispatch doctor — print setup status from /api/setup/state"
```

---

## Phase 2 — Wizard scaffold + Agents step + gating + Settings re-entry

### Task 4: Web setup API client + types

**Files:**
- Modify: `packages/web/src/api/types.ts`
- Modify: `packages/web/src/api/client.ts`

**Interfaces:**
- Produces (types): `ProviderStatus`, `TailscaleStatus`, `SetupState` mirroring Task 1/2.
- Produces (client): `api.getSetupState()`, `api.recheckProviders()`, `api.recheckTailscale()`, `api.completeSetup()`.

- [ ] **Step 1: Add types**

Append to `packages/web/src/api/types.ts`:

```ts
export interface ProviderStatus { name: 'claude' | 'codex'; installed: boolean; version?: string; signedIn: boolean | 'unknown'; }
export interface TailscaleStatus { installed: boolean; running: boolean; dnsName?: string; url?: string; }
export interface SetupState { firstRun: boolean; providers: ProviderStatus[]; tailscale: TailscaleStatus; secrets: { connected: boolean }; }
```

- [ ] **Step 2: Add client methods**

In `packages/web/src/api/client.ts`, add to the `api` object (mirror the existing `req<…>` helper used by `getConversation`/`searchConversation`) and import the new types:

```ts
  getSetupState: () => req<SetupState>(`/api/setup/state`),
  recheckProviders: () => req<ProviderStatus[]>(`/api/setup/providers`),
  recheckTailscale: () => req<TailscaleStatus>(`/api/setup/tailscale`),
  completeSetup: () => req<{ ok: true }>(`/api/setup/complete`, { method: 'POST' }),
```

Add to the existing `import type { … } from './types'` line: `SetupState, ProviderStatus, TailscaleStatus`.

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter dispatch-web exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/web/src/api/types.ts packages/web/src/api/client.ts
git commit -m "feat(web): setup API client + types"
```

---

### Task 5: Wizard store + scaffold + Agents step + first-run gating

**Files:**
- Create: `packages/web/src/stores/setup.ts`
- Create: `packages/web/src/components/setup/SetupWizard.tsx`
- Create: `packages/web/src/components/setup/SetupWizard.test.tsx`
- Modify: `packages/web/src/App.tsx` (render `<SetupWizard/>`)

**Interfaces:**
- Consumes: `api.getSetupState/recheckProviders/completeSetup` (Task 4).
- Produces: `useSetup` store `{ forceOpen: boolean; open(): void; close(): void }`; default-exported nothing — named `SetupWizard` component.

- [ ] **Step 1: Write the wizard store**

```ts
// packages/web/src/stores/setup.ts
import { create } from 'zustand';

export const useSetup = create<{ forceOpen: boolean; open: () => void; close: () => void }>((set) => ({
  forceOpen: false,
  open: () => set({ forceOpen: true }),
  close: () => set({ forceOpen: false }),
}));
```

- [ ] **Step 2: Write the failing test**

```tsx
// packages/web/src/components/setup/SetupWizard.test.tsx
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { vi, test, expect, beforeEach } from 'vitest';

const getSetupState = vi.fn();
const completeSetup = vi.fn().mockResolvedValue({ ok: true });
const recheckProviders = vi.fn();
vi.mock('../../api/client', () => ({ api: { getSetupState: () => getSetupState(), completeSetup: () => completeSetup(), recheckProviders: () => recheckProviders(), recheckTailscale: () => Promise.resolve({ installed: false, running: false }) } }));

import { SetupWizard } from './SetupWizard';

beforeEach(() => { getSetupState.mockReset(); completeSetup.mockClear(); });

test('renders nothing when not first run', async () => {
  getSetupState.mockResolvedValue({ firstRun: false, providers: [], tailscale: { installed: false, running: false }, secrets: { connected: false } });
  const { container } = render(<SetupWizard />);
  await waitFor(() => expect(getSetupState).toHaveBeenCalled());
  expect(container.textContent).not.toMatch(/Get Dispatch on your phone|Agents/);
});

test('shows the Agents step on first run with provider badges', async () => {
  getSetupState.mockResolvedValue({ firstRun: true, providers: [{ name: 'claude', installed: true, signedIn: true }, { name: 'codex', installed: false, signedIn: false }], tailscale: { installed: false, running: false }, secrets: { connected: false } });
  render(<SetupWizard />);
  await waitFor(() => expect(screen.getByText(/Claude Code/i)).toBeInTheDocument());
  expect(screen.getByText(/npm i -g @openai\/codex/)).toBeInTheDocument();
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter dispatch-web exec vitest run src/components/setup/SetupWizard.test.tsx`
Expected: FAIL — cannot resolve `./SetupWizard`.

- [ ] **Step 4: Write the wizard (scaffold + Agents step)**

```tsx
// packages/web/src/components/setup/SetupWizard.tsx
import { useEffect, useState, useCallback } from 'react';
import type { SetupState, ProviderStatus } from '../../api/types';
import { api } from '../../api/client';
import { useSetup } from '../../stores/setup';

type Step = 'agents' | 'mobile' | 'secrets' | 'done';
const ORDER: Step[] = ['agents', 'mobile', 'secrets', 'done'];

const INSTALL: Record<'claude' | 'codex', { label: string; install: string; login: string }> = {
  claude: { label: 'Claude Code', install: 'npm i -g @anthropic-ai/claude-code', login: 'claude' },
  codex: { label: 'Codex', install: 'npm i -g @openai/codex', login: 'codex login' },
};

export function SetupWizard() {
  const forceOpen = useSetup((s) => s.forceOpen);
  const closeForce = useSetup((s) => s.close);
  const [state, setState] = useState<SetupState | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [step, setStep] = useState<Step>('agents');

  useEffect(() => { void api.getSetupState().then(setState).catch(() => setState(null)); }, []);

  const visible = !!state && !dismissed && (state.firstRun || forceOpen);
  const finish = useCallback(async () => { try { await api.completeSetup(); } catch { /* best-effort */ } setDismissed(true); closeForce(); }, [closeForce]);
  if (!visible) return null;

  const idx = ORDER.indexOf(step);
  const next = () => setStep(ORDER[Math.min(idx + 1, ORDER.length - 1)]);
  const back = () => setStep(ORDER[Math.max(idx - 1, 0)]);

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,.6)' }}>
      <div style={{ width: 'min(560px, 94vw)', maxHeight: '88vh', overflowY: 'auto', background: 'var(--color-pane)', border: '1px solid var(--color-border)', borderRadius: 16, padding: 22, boxShadow: '0 24px 60px -12px rgba(0,0,0,.7)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
          <strong style={{ fontSize: 16 }}>Set up Dispatch</strong>
          <button onClick={finish} style={{ background: 'none', border: 'none', color: 'var(--color-text-tertiary)', cursor: 'pointer', fontSize: 13 }}>Skip all</button>
        </div>
        {step === 'agents' && <AgentsStep providers={state.providers} />}
        {step === 'mobile' && <div data-testid="mobile-step">Mobile step (Task 7)</div>}
        {step === 'secrets' && <div data-testid="secrets-step">Secrets step (Task 8)</div>}
        {step === 'done' && <div>You're all set. Reopen this anytime from Settings → Getting started.</div>}
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 20 }}>
          <button onClick={back} disabled={idx === 0} style={btn(false)}>Back</button>
          {step === 'done'
            ? <button onClick={finish} style={btn(true)}>Finish</button>
            : <button onClick={next} style={btn(true)}>Continue</button>}
        </div>
      </div>
    </div>
  );
}

function btn(primary: boolean): React.CSSProperties {
  return { height: 34, padding: '0 16px', borderRadius: 9, border: '1px solid var(--color-border)', cursor: 'pointer', fontWeight: 600, fontSize: 13, background: primary ? 'var(--color-accent)' : 'transparent', color: primary ? '#08240F' : 'var(--color-text-secondary)' };
}

function AgentsStep({ providers: initial }: { providers: ProviderStatus[] }) {
  const [providers, setProviders] = useState(initial);
  const [checking, setChecking] = useState(false);
  const recheck = async () => { setChecking(true); try { setProviders(await api.recheckProviders()); } catch { /* keep prior */ } setChecking(false); };
  return (
    <div>
      <p style={{ color: 'var(--color-text-secondary)', fontSize: 13, marginTop: 0 }}>Dispatch drives your local Claude Code / Codex CLIs. Install and sign in to the ones you want.</p>
      {providers.map((p) => {
        const meta = INSTALL[p.name];
        const ok = p.installed && p.signedIn === true;
        return (
          <div key={p.name} style={{ border: '1px solid var(--color-border)', borderRadius: 10, padding: 12, marginBottom: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ color: ok ? 'var(--color-accent)' : 'var(--color-status-red)' }}>{ok ? '✓' : '✗'}</span>
              <strong style={{ fontSize: 13.5 }}>{meta.label}</strong>
              <span style={{ fontSize: 12, color: 'var(--color-text-tertiary)' }}>
                {p.installed ? (p.signedIn === true ? 'signed in' : p.signedIn === 'unknown' ? 'installed · sign-in unknown' : 'installed · signed out') : 'not found'}
              </span>
            </div>
            {!ok && (
              <pre style={{ margin: '8px 0 0', font: '400 11.5px var(--font-mono)', background: 'var(--color-elevated)', borderRadius: 8, padding: '8px 10px', whiteSpace: 'pre-wrap' }}>{meta.install}{'\n'}{meta.login}</pre>
            )}
          </div>
        );
      })}
      <button onClick={recheck} disabled={checking} style={btn(false)}>{checking ? 'Checking…' : 'Re-check'}</button>
    </div>
  );
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter dispatch-web exec vitest run src/components/setup/SetupWizard.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 6: Mount in App.tsx**

In `packages/web/src/App.tsx`, import and render the wizard at the root of the returned tree so it overlays both desktop and mobile. Add the import:

```tsx
import { SetupWizard } from './components/setup/SetupWizard';
```

Wrap the existing return in a fragment and add `<SetupWizard />` as a sibling, e.g.:

```tsx
  return (
    <>
      <SetupWizard />
      {/* …existing top-level return (AppShell / MobileApp) unchanged… */}
    </>
  );
```

(If the component already returns a single root element, wrap it: `<>{<SetupWizard />}{existing}</>`.)

- [ ] **Step 7: Typecheck + commit**

Run: `pnpm --filter dispatch-web exec tsc --noEmit`

```bash
git add packages/web/src/stores/setup.ts packages/web/src/components/setup/SetupWizard.tsx packages/web/src/components/setup/SetupWizard.test.tsx packages/web/src/App.tsx
git commit -m "feat(web): SetupWizard scaffold + Agents step + first-run gating"
```

---

### Task 6: Settings re-entry ("Getting started")

**Files:**
- Modify: `packages/web/src/components/settings/SettingsModal.tsx`

**Interfaces:**
- Consumes: `useSetup().open()` (Task 5).

- [ ] **Step 1: Add a "Getting started" button to Settings**

In `SettingsModal.tsx`, import the store:

```tsx
import { useSetup } from '../../stores/setup';
```

Inside the component, get the opener and add a button near the top of the settings body (match the existing section/button styling in that file):

```tsx
  const openSetup = useSetup((s) => s.open);
  // …within the rendered settings sections:
  <button onClick={() => { openSetup(); onClose(); }} style={{ /* reuse the file's existing button style */ }}>
    Getting started / re-run setup
  </button>
```

(Use the same button styling already present in `SettingsModal.tsx`; do not invent a new style system.)

- [ ] **Step 2: Verify manually**

Run web build + open Settings → click "Getting started" → wizard overlay appears (even when `firstRun` is false, because `forceOpen` is set).

Run: `pnpm --filter dispatch-web exec tsc --noEmit && pnpm --filter dispatch-web build`
Expected: clean typecheck + build.

- [ ] **Step 3: Commit**

```bash
git add packages/web/src/components/settings/SettingsModal.tsx
git commit -m "feat(web): re-open the setup wizard from Settings"
```

---

## Phase 3 — Mobile / Tailscale step

### Task 7: Tailscale step with URL + QR

**Files:**
- Modify: `packages/web/package.json` (add `qrcode` + `@types/qrcode`)
- Modify: `packages/web/src/components/setup/SetupWizard.tsx` (replace the `mobile-step` placeholder)
- Modify: `packages/web/src/components/setup/SetupWizard.test.tsx` (add a Tailscale test)

**Interfaces:**
- Consumes: `api.recheckTailscale()` (Task 4); `qrcode` `toDataURL`.

- [ ] **Step 1: Add the QR dependency**

Run: `cd /Users/davidwebber/Sites/dispatch && pnpm --filter dispatch-web add qrcode && pnpm --filter dispatch-web add -D @types/qrcode`
Expected: both added to `packages/web/package.json`.

- [ ] **Step 2: Write the failing test (add to SetupWizard.test.tsx)**

```tsx
test('mobile step shows the tailnet URL when running', async () => {
  getSetupState.mockResolvedValue({ firstRun: true, providers: [], tailscale: { installed: true, running: true, dnsName: 'my-mac.ts.net', url: 'http://my-mac.ts.net:3456' }, secrets: { connected: false } });
  render(<SetupWizard />);
  await waitFor(() => expect(screen.getByText(/Agents|Claude/i)).toBeInTheDocument());
  fireEvent.click(screen.getByText('Continue')); // → mobile step
  await waitFor(() => expect(screen.getByText('http://my-mac.ts.net:3456')).toBeInTheDocument());
});
```

Also `vi.mock` for `qrcode`: add at the top of the test file:

```tsx
vi.mock('qrcode', () => ({ default: { toDataURL: async () => 'data:image/png;base64,stub' } }));
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter dispatch-web exec vitest run src/components/setup/SetupWizard.test.tsx`
Expected: FAIL — the URL text isn't rendered (placeholder still there).

- [ ] **Step 4: Implement the MobileStep**

In `SetupWizard.tsx`, add the import and replace the `mobile-step` placeholder with `<MobileStep tailscale={state.tailscale} />`, then add:

```tsx
import QRCode from 'qrcode';
import type { TailscaleStatus } from '../../api/types';

function MobileStep({ tailscale: initial }: { tailscale: TailscaleStatus }) {
  const [ts, setTs] = useState(initial);
  const [qr, setQr] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const recheck = async () => { setChecking(true); try { setTs(await api.recheckTailscale()); } catch { /* keep */ } setChecking(false); };
  useEffect(() => { if (ts.url) QRCode.toDataURL(ts.url, { width: 180, margin: 1 }).then(setQr).catch(() => setQr(null)); else setQr(null); }, [ts.url]);
  return (
    <div>
      <p style={{ color: 'var(--color-text-secondary)', fontSize: 13, marginTop: 0 }}>Reach Dispatch from your phone privately over Tailscale — no public exposure.</p>
      {ts.running && ts.url ? (
        <div style={{ textAlign: 'center' }}>
          {qr && <img src={qr} alt="Open on phone" style={{ borderRadius: 10, background: '#fff', padding: 8 }} />}
          <div style={{ font: '500 13px var(--font-mono)', marginTop: 10, wordBreak: 'break-all' }}>{ts.url}</div>
          <p style={{ fontSize: 12, color: 'var(--color-text-tertiary)' }}>Install the Tailscale app on your phone, sign into the same account, then open this URL.</p>
        </div>
      ) : (
        <div>
          <p style={{ fontSize: 13 }}>{ts.installed ? 'Tailscale is installed but not running. Start it, then re-check.' : 'Install Tailscale on this Mac:'}</p>
          {!ts.installed && <pre style={{ font: '400 11.5px var(--font-mono)', background: 'var(--color-elevated)', borderRadius: 8, padding: '8px 10px' }}>brew install --cask tailscale{'\n'}tailscale up</pre>}
          <button onClick={recheck} disabled={checking} style={btn(false)}>{checking ? 'Checking…' : 'Re-check'}</button>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 5: Run tests + typecheck**

Run: `pnpm --filter dispatch-web exec vitest run src/components/setup/SetupWizard.test.tsx && pnpm --filter dispatch-web exec tsc --noEmit`
Expected: PASS (3 tests) + clean typecheck.

- [ ] **Step 6: Commit**

```bash
git add packages/web/package.json packages/web/src/components/setup/SetupWizard.tsx packages/web/src/components/setup/SetupWizard.test.tsx pnpm-lock.yaml
git commit -m "feat(web): wizard Mobile step — Tailscale URL + QR"
```

---

## Phase 4 — Secrets step

### Task 8: Doppler secrets step (optional, skippable)

**Files:**
- Modify: `packages/web/src/components/setup/SetupWizard.tsx` (replace the `secrets-step` placeholder)

**Interfaces:**
- Consumes: the existing Doppler connect UI. First, identify the reusable piece in `packages/web/src/components/settings/` (the Secrets section that calls `api` secrets endpoints). Extract it into a small `<DopplerConnect />` component if it is currently inlined in `SettingsModal`, so both Settings and the wizard render the same thing (DRY).

- [ ] **Step 1: Locate + extract the Doppler connect UI**

Find the secrets section in `SettingsModal.tsx` (search for `secrets` / `doppler` / `connection`). If it is inlined, cut it into:

```tsx
// packages/web/src/components/settings/DopplerConnect.tsx
// (Move the existing secrets-section JSX + its local state/handlers here verbatim.
//  Export `export function DopplerConnect() { … }` and render <DopplerConnect/> in SettingsModal.)
```

If a standalone secrets component already exists, skip extraction and reuse it directly.

- [ ] **Step 2: Render it in the wizard's secrets step**

In `SetupWizard.tsx`, replace the `secrets-step` placeholder:

```tsx
import { DopplerConnect } from '../settings/DopplerConnect';
// …
{step === 'secrets' && (
  <div>
    <p style={{ color: 'var(--color-text-secondary)', fontSize: 13, marginTop: 0 }}>Optional — connect Doppler so agents can read your secrets. You can skip this.</p>
    <DopplerConnect />
  </div>
)}
```

The existing "Continue"/"Skip all" buttons already let the user move past it, so no extra Skip control is needed.

- [ ] **Step 3: Verify + typecheck**

Run: `pnpm --filter dispatch-web exec tsc --noEmit && pnpm --filter dispatch-web exec vitest run` (full web suite)
Expected: clean typecheck; existing + new tests pass. Manually: Settings secrets section still works (same component).

- [ ] **Step 4: Commit**

```bash
git add packages/web/src/components/settings/ packages/web/src/components/setup/SetupWizard.tsx
git commit -m "feat(web): wizard Secrets step reuses the Doppler connect UI"
```

---

## Phase 5 — One-line installer + public-repo prep

### Task 9: Bootstrap `install.sh` (clone + build + install)

**Files:**
- Modify: `scripts/install.sh`

**Interfaces:**
- Produces: a script runnable two ways — piped from the network (`curl … | sh`, no repo yet) **and** from inside a checkout (delegates to `bin/dispatch install`).

- [ ] **Step 1: Replace install.sh with the bootstrap version**

```bash
#!/usr/bin/env bash
# Dispatch one-line installer.
#   Remote:  curl -fsSL <public-url>/scripts/install.sh | sh
#   Local:   ./scripts/install.sh
set -uo pipefail

REPO_URL="${DISPATCH_REPO_URL:-https://github.com/davidwebber10/dispatch.git}"
APP_DIR="${DISPATCH_APP_DIR:-$HOME/.dispatch/app}"
CHECK_ONLY=false
[ "${1:-}" = "--check" ] && CHECK_ONLY=true

red() { printf '\033[31m%s\033[0m\n' "$1" >&2; }
green() { printf '\033[32m%s\033[0m\n' "$1"; }
bold() { printf '\033[1m%s\033[0m\n' "$1"; }

[ "$(uname)" = "Darwin" ] || { red "Dispatch's daemon is macOS-only (launchd)."; exit 1; }
command -v git >/dev/null 2>&1 || { red "git not found — install Xcode Command Line Tools: xcode-select --install"; exit 1; }
command -v node >/dev/null 2>&1 || { red "Node.js 18+ not found — install from https://nodejs.org and retry."; exit 1; }
if ! command -v pnpm >/dev/null 2>&1; then
  if command -v corepack >/dev/null 2>&1; then corepack enable >/dev/null 2>&1 || true; fi
  command -v pnpm >/dev/null 2>&1 || { red "pnpm not found — run: npm i -g pnpm   (or: corepack enable)"; exit 1; }
fi

if $CHECK_ONLY; then green "Prerequisites OK (macOS, git, node, pnpm)."; exit 0; fi

# If we're already inside a checkout (local run), use it; otherwise clone.
SELF_REPO="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." 2>/dev/null && pwd || true)"
if [ -n "$SELF_REPO" ] && [ -f "$SELF_REPO/bin/dispatch" ]; then
  TARGET="$SELF_REPO"
else
  bold "Cloning Dispatch → $APP_DIR"
  mkdir -p "$(dirname "$APP_DIR")"
  if [ -d "$APP_DIR/.git" ]; then ( cd "$APP_DIR" && git pull --ff-only ); else git clone "$REPO_URL" "$APP_DIR"; fi
  TARGET="$APP_DIR"
fi

bold "Building + installing the daemon…"
( cd "$TARGET" && ./bin/dispatch build && ./bin/dispatch install ) || { red "Install failed."; exit 1; }

# Best-effort: put `dispatch` on PATH (non-fatal).
for d in /usr/local/bin "$HOME/.local/bin"; do
  if [ -d "$d" ] && [ -w "$d" ]; then ln -sf "$TARGET/bin/dispatch" "$d/dispatch" && break; fi
done

green "Dispatch is running → http://localhost:3456"
command -v open >/dev/null 2>&1 && open "http://localhost:3456" || true
echo "Next: the in-app wizard will walk you through agents, mobile (Tailscale), and secrets."
```

- [ ] **Step 2: Verify the dry run**

Run: `bash scripts/install.sh --check`
Expected: `Prerequisites OK (macOS, git, node, pnpm).` and exit 0. (Do NOT run the full installer here — it would reinstall the daemon and could disrupt the running session.)

- [ ] **Step 3: Commit**

```bash
git add scripts/install.sh
git commit -m "feat(installer): one-line bootstrap (clone + build + install + PATH) with --check"
```

---

### Task 10: Public-repo prep — secret audit + docs

**Files:**
- Modify: `README.md` (one-liner install + wizard mention)
- Modify: `docs/providers.md` (link the wizard's detect+guide flow)

**Interfaces:** none (docs + audit).

- [ ] **Step 1: Audit git history for committed secrets (BLOCKING before making the repo public)**

Run:

```bash
cd /Users/davidwebber/Sites/dispatch
git log -p | grep -nEi 'dp\.pt\.|sk-[a-z0-9]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN|api[_-]?key|authorization: bearer|cloudflare.*token' | head -50
```

Expected: review every hit. If any real secret is found in history, STOP and report — the repo must be scrubbed (e.g. `git filter-repo`) or recreated before going public. Record the result in the commit message.

- [ ] **Step 2: Update README quick start to the one-liner**

Replace the `## Quick start` clone+build block in `README.md` with:

```markdown
## Quick start

```bash
curl -fsSL https://raw.githubusercontent.com/davidwebber10/dispatch/main/scripts/install.sh | sh
```

This installs prerequisites guidance, builds Dispatch, starts the background daemon, and
opens `http://localhost:3456`. A first-run wizard then walks you through your agents
(Claude Code / Codex), mobile access (Tailscale), and optional secrets (Doppler).
```

- [ ] **Step 3: Add a wizard note to docs/providers.md**

Add near the top of `docs/providers.md`:

```markdown
> The in-app setup wizard (and `dispatch doctor`) auto-detect whether `claude` / `codex`
> are installed and signed in, and show the exact install + login commands. This page is the
> detailed reference behind that.
```

- [ ] **Step 4: Commit**

```bash
git add README.md docs/providers.md
git commit -m "docs: one-line install + wizard/doctor references; record secret-audit result"
```

---

## Self-Review Notes (author)

- **Spec coverage:** detect module (T1), routes + firstRun persistence (T2), `dispatch doctor` (T3), web client (T4), wizard + Agents + gating + Settings re-entry (T5/T6), Tailscale + QR (T7), Doppler step (T8), installer (T9), public-repo prep + secret audit (T10). All spec sections mapped.
- **Deferred per spec:** writing the tailnet URL into the server-switcher list (v1 shows URL+QR only).
- **Risk to confirm during execution:** exact Doppler-connect JSX location in `SettingsModal.tsx` (T8 Step 1) and the precise `req(...)` helper signature in `client.ts` (T4 Step 2) — both verified to exist; adjust to the file's actual local conventions.
- **Cred-file heuristics** (`~/.claude/.credentials.json`, `~/.codex/auth.json`) are best-effort; `'unknown'` is a first-class state surfaced in the UI, so a wrong guess never blocks.
