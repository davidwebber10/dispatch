# WSL2 Windows Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dispatch runs inside WSL2 as a first-class platform: Reveal in File Explorer, host-browser localness, autostart via a Windows logon task, self-update — all behind the `Platform` abstraction so every capability exists on darwin/wsl/linux or the build fails.

**Architecture:** Phase 0 extracts the platform module + cross-platform CLI from `origin/worktree-windows-native-impl` (win32 files stay parked there). Then `wsl` joins `selectPlatform()` as `{ ...linux }` plus an interop delta (`wslpath`/`explorer.exe`/`schtasks.exe` via WSL interop). New `Platform` methods (`fileManagerName`, `revealInFileManager`, `isLocalClient`, `toolPlatformKey`, `tailscaleStatus`) are the parity ratchet.

**Tech Stack:** TypeScript ESM, vitest, Express, pnpm monorepo. No new dependencies.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-15-wsl2-windows-support-design.md`.
- WSL2-only Windows story: no `win32.ts`/`daemon-win32.ts`/`win32-task-xml.ts`/`windows.yml` in the tree; `selectPlatform('win32')` throws.
- No `process.platform` reads outside `packages/core/src/platform/` (existing branch rule; `routes/state.ts` may echo it in the `/host` payload only).
- All exec calls use argument arrays, never shell strings.
- Run core tests from `packages/core`, web tests from `packages/web` (`npx vitest run`) — never from the repo root.
- Commit after every task; work stays on branch `worktree-wsl2-flavor`.
- systemd must NOT be required inside WSL.

---

### Task 1: Phase 0a — extract the platform module (darwin + linux, no win32)

**Files:**
- Create (from branch): `packages/core/src/platform/{types.ts,index.ts,darwin.ts,linux.ts,daemon.ts,daemon-darwin.ts,encode.ts}`
- Create (from branch): `packages/core/tests/platform/{index.test.ts,darwin.test.ts,daemon-darwin.test.ts,encode.test.ts}`
- Modify: `packages/core/src/platform/index.ts` (drop win32), `packages/core/src/platform/encode.ts` (drop win32 arm)

**Interfaces:**
- Produces: `platform` singleton, `selectPlatform(plat)`, `Platform` interface (`id`, `defaultShell()`, `resolveLoginPath()`, `dataDir()`, `logDir()`, `resolveCommand()`, `listProcessIds()`, `claudeProjectDir()`, `installBrowserShim()`, `daemon: DaemonController`), `DaemonController` (`install/uninstall/start/stop/restart/status`).

- [ ] **Step 1: Bring the files over from the branch**

```bash
cd /Users/davidwebber/Sites/dispatch/.claude/worktrees/wsl2-flavor
git checkout origin/worktree-windows-native-impl -- \
  packages/core/src/platform packages/core/tests/platform
git rm -f packages/core/src/platform/win32.ts packages/core/src/platform/win32-util.ts \
  packages/core/src/platform/win32-task-xml.ts packages/core/src/platform/daemon-win32.ts \
  packages/core/tests/platform/win32.test.ts packages/core/tests/platform/win32-util.test.ts \
  packages/core/tests/platform/win32-task-xml.test.ts packages/core/tests/platform/daemon-win32.test.ts
```

- [ ] **Step 2: Excise win32 from `index.ts`**

Replace the win32 import and case so unknown platforms throw:

```ts
import { darwin } from './darwin.js';
import { linux } from './linux.js';
import type { Platform } from './types.js';

export function selectPlatform(plat: NodeJS.Platform = process.platform): Platform {
  switch (plat) {
    case 'darwin': return darwin;
    case 'linux':  return linux;
    default:
      throw new Error(`Dispatch does not support platform "${plat}" (darwin/linux only; Windows runs Dispatch inside WSL2).`);
  }
}

export const platform: Platform = selectPlatform();
export type { Platform, ShellSpec, BrowserShimOptions, BrowserShimEnv } from './types.js';
export type { DaemonController, DaemonInstallOptions, DaemonStatus } from './daemon.js';
```

In `encode.ts`, narrow the signature to `platform: 'darwin'` and delete the win32 branch (grep `packages/core` for `encodeClaudeProjectDir(` callers and drop the second argument where the branch passed `'win32'`). In `packages/core/tests/platform/index.test.ts` and `encode.test.ts`, delete the win32 cases and assert `selectPlatform('win32' as NodeJS.Platform)` throws.

- [ ] **Step 3: Run the platform tests**

Run: `cd packages/core && npx vitest run tests/platform`
Expected: PASS (darwin/linux/encode/index suites; zero references to win32 remain — verify with `rg -l win32 src tests`, expect no platform files).

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat(platform): extract platform abstraction from windows-native branch (darwin+linux; win32 parked)"
```

---

### Task 2: Phase 0b — extract `packages/cli` and the thin `bin/dispatch` shim

**Files:**
- Create (from branch): `packages/cli/` (package.json, tsconfig.json, src/index.ts, tests/commands.test.ts)
- Modify (from branch): `bin/dispatch` (bash → sh shim exec'ing the CLI), root `package.json`
- Delete: `scripts/install.sh` Darwin hard-fail comes later (Task 12); leave it now.

**Interfaces:**
- Produces: `dispatch build|install|uninstall|start|stop|restart|status|logs|update|release|run|tools` via `packages/cli/src/index.ts` `main()`; `cmdUpdate(ctx)` and `cmdRun(ctx)` are extended in Tasks 11–12.

- [ ] **Step 1: Bring the files over**

```bash
git checkout origin/worktree-windows-native-impl -- packages/cli bin/dispatch
git diff origin/worktree-windows-native-impl -- package.json | git apply -R --include=package.json || \
  git checkout origin/worktree-windows-native-impl -- package.json
```

Then re-set `"version"` in root `package.json` to the current main value (the branch copy is stale): check with `git show main:package.json | jq -r .version` and edit to match.

- [ ] **Step 2: Install + build + test**

Run: `pnpm install && pnpm -r run build && cd packages/cli && npx vitest run`
Expected: lockfile updates for `packages/cli`; build passes; CLI tests PASS.

- [ ] **Step 3: Smoke the CLI on macOS**

Run: `./bin/dispatch status`
Expected: prints daemon status (loaded/not) without bash errors — proves the shim resolves the built CLI.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat(cli): extract cross-platform dispatch CLI from windows-native branch"
```

---

### Task 3: Phase 0c — rewire core consumers onto `platform`

**Files:**
- Modify: `packages/core/src/server.ts` (delete local `resolveShellPath()`; use `platform.resolveLoginPath()`, `platform.dataDir()`, `platform.installBrowserShim()`, `platform.listProcessIds()`)
- Modify: `packages/core/src/providers/claude-code.ts` (transcript dir via `platform.claudeProjectDir(workDir)`)
- Modify: `packages/core/src/sessions/service.ts:1191` (`command = '/bin/zsh'` → `platform.defaultShell()`)
- Modify: `packages/core/src/routes/state.ts` (`/tailscale` returns `{ip:null,hostname:null,online:false}` when `platform.id !== 'darwin'` — interim until Task 8)

Use `git diff main...origin/worktree-windows-native-impl -- <file>` as the reference for each hunk and apply it by hand (the branch's diffs were written against an older main; current main has drifted — e.g. `server.ts` grew the TerminalMonitor wiring). For `sessions/service.ts`:

```ts
// before
command = '/bin/zsh';
// after
const shell = platform.defaultShell();
command = shell.command;
args = shell.args;
```

(match the surrounding variable names at `service.ts:1191` — the PTY spawn for `type: 'shell'` terminals).

- [ ] **Step 1: Apply the four rewires** (reference diffs above; imports: `import { platform } from '../platform/index.js';` adjusted per depth)
- [ ] **Step 2: Full core suite**

Run: `cd packages/core && npx vitest run`
Expected: PASS. If transcript-dir tests fail on encoding, the caller in `claude-code.ts` must pass through `platform.claudeProjectDir` (not re-encode).

- [ ] **Step 3: Runtime smoke (isolated daemon)** — per `.claude/skills/verify/SKILL.md`: fake HOME, `PORT=3999`, create a session + shell terminal, confirm the PTY spawns with your login shell and `GET /api/state/tailscale` still answers on macOS.
- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "refactor(core): route all platform-divergent calls through the platform module"
```

---

### Task 4: WSL detection + `wsl` platform skeleton

**Files:**
- Create: `packages/core/src/platform/wsl.ts`
- Modify: `packages/core/src/platform/index.ts`
- Test: `packages/core/tests/platform/wsl.test.ts`

**Interfaces:**
- Produces: `detectWsl(env?, readProcVersion?)`, `createWslPlatform(deps?)`, `wsl` (default instance). `WslDeps { execFile(cmd, args): Promise<{stdout: string}>; readFileSync(p: string): string; env: NodeJS.ProcessEnv }`.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/core/tests/platform/wsl.test.ts
import { describe, test, expect } from 'vitest';
import { detectWsl, createWslPlatform } from '../../src/platform/wsl.js';

describe('detectWsl', () => {
  test('true when WSL_DISTRO_NAME is set', () => {
    expect(detectWsl({ WSL_DISTRO_NAME: 'Ubuntu' } as NodeJS.ProcessEnv, () => '')).toBe(true);
  });
  test('true when /proc/version mentions microsoft', () => {
    expect(detectWsl({} as NodeJS.ProcessEnv, () => 'Linux version 5.15.153.1-microsoft-standard-WSL2')).toBe(true);
  });
  test('false on plain linux', () => {
    expect(detectWsl({} as NodeJS.ProcessEnv, () => 'Linux version 6.8.0-generic')).toBe(false);
  });
  test('false when /proc/version is unreadable', () => {
    expect(detectWsl({} as NodeJS.ProcessEnv, () => { throw new Error('ENOENT'); })).toBe(false);
  });
});

describe('wsl platform', () => {
  test('is linux with flavor wsl', () => {
    const p = createWslPlatform();
    expect(p.id).toBe('linux');
    expect(p.logDir()).toContain('.dispatch');
  });
});
```

- [ ] **Step 2: Run to verify failure** — `cd packages/core && npx vitest run tests/platform/wsl.test.ts` → FAIL (module not found).
- [ ] **Step 3: Implement**

```ts
// packages/core/src/platform/wsl.ts
import fs from 'fs';
import { linux } from './linux.js';
import type { Platform } from './types.js';

export interface WslDeps {
  execFile(cmd: string, args: string[]): Promise<{ stdout: string }>;
  readFileSync(p: string): string;
  env: NodeJS.ProcessEnv;
}

const defaultDeps: WslDeps = {
  execFile: async (cmd, args) => {
    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    return promisify(execFile)(cmd, args, { timeout: 5000 }) as Promise<{ stdout: string }>;
  },
  readFileSync: (p) => fs.readFileSync(p, 'utf-8'),
  env: process.env,
};

/** WSL_DISTRO_NAME is absent in some daemon contexts; /proc/version is authoritative. */
export function detectWsl(
  env: NodeJS.ProcessEnv = process.env,
  readProcVersion: () => string = () => fs.readFileSync('/proc/version', 'utf-8'),
): boolean {
  if (env.WSL_DISTRO_NAME) return true;
  try { return /microsoft/i.test(readProcVersion()); } catch { return false; }
}

export function createWslPlatform(deps: WslDeps = defaultDeps): Platform {
  void deps; // capability overrides land in Tasks 6, 10
  return { ...linux };
}

export const wsl: Platform = createWslPlatform();
```

- [ ] **Step 4: Wire selection** — in `index.ts`:

```ts
import { detectWsl } from './wsl.js';
import { wsl } from './wsl.js';
// inside selectPlatform:
case 'linux': return detectWsl() ? wsl : linux;
```

Add an index test: `selectPlatform('linux')` returns a platform whose `id === 'linux'` (detection is env-dependent; the wsl-vs-linux distinction is covered by `wsl.test.ts`).

- [ ] **Step 5: Run tests + commit**

Run: `npx vitest run tests/platform` → PASS.

```bash
git add -A && git commit -m "feat(platform): wsl detection and platform skeleton"
```

---

### Task 5: New `Platform` capabilities — darwin + linux answers

**Files:**
- Modify: `packages/core/src/platform/types.ts`, `darwin.ts`, `linux.ts`
- Test: `packages/core/tests/platform/capabilities.test.ts`

**Interfaces:**
- Produces (on `Platform`):

```ts
readonly flavor: 'macos' | 'wsl' | 'linux';
readonly fileManagerName: string | null;          // null → Reveal never offered
revealInFileManager(absPaths: string[]): Promise<void>;
isLocalClient(client: RevealClient): boolean;      // RevealClient from ../files/reveal.js
toolPlatformKey(): string;                         // 'darwin-arm64' | 'darwin-x64' | 'linux-x64' | 'linux-arm64'
tailscaleStatus(): Promise<TailscaleStatus>;       // { ip: string|null; hostname: string|null; online: boolean }
```

`TailscaleStatus` is declared in `types.ts`. (The spec calls this `detectTunnels`; it is named `tailscaleStatus` because the only consumer, `GET /api/state/tailscale`, surfaces Tailscale alone — YAGNI.)
- Consumes: `isLoopbackAddress`, `isLoopbackHost`, `RevealClient` from `../files/reveal.js` (already exported).

- [ ] **Step 1: Write the failing tests**

```ts
// packages/core/tests/platform/capabilities.test.ts
import { describe, test, expect } from 'vitest';
import { darwin } from '../../src/platform/darwin.js';
import { linux } from '../../src/platform/linux.js';

const local = { remoteAddress: '127.0.0.1', host: 'localhost:3456', proxied: false };
const proxied = { ...local, proxied: true };
const lan = { remoteAddress: '192.168.1.20', host: '192.168.1.5:3456', proxied: false };

describe('darwin capabilities', () => {
  test('file manager is Finder', () => expect(darwin.fileManagerName).toBe('Finder'));
  test('local loopback client accepted', () => expect(darwin.isLocalClient(local)).toBe(true));
  test('proxied and LAN clients refused', () => {
    expect(darwin.isLocalClient(proxied)).toBe(false);
    expect(darwin.isLocalClient(lan)).toBe(false);
  });
  test('tool key matches arch', () =>
    expect(darwin.toolPlatformKey()).toBe(process.arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64'));
});

describe('linux capabilities', () => {
  test('headless: no file manager, reveal throws', async () => {
    expect(linux.fileManagerName).toBeNull();
    await expect(linux.revealInFileManager(['/tmp/x'])).rejects.toThrow(/not supported/i);
  });
  test('loopback rule holds', () => {
    expect(linux.isLocalClient(local)).toBe(true);
    expect(linux.isLocalClient(lan)).toBe(false);
  });
  test('tool key is linux-*', () => expect(linux.toolPlatformKey()).toMatch(/^linux-(x64|arm64)$/));
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run tests/platform/capabilities.test.ts` → FAIL (properties missing) and `npx tsc -b` fails for `wsl.ts` too (spread of `linux` no longer satisfies… it does — spread copies; the compile failure comes only from `types.ts` consumers until impls exist. Expect: type errors in `darwin.ts`/`linux.ts`).
- [ ] **Step 3: Implement**

`types.ts` — add the block from **Interfaces** plus:

```ts
export interface TailscaleStatus { ip: string | null; hostname: string | null; online: boolean }
import type { RevealClient } from '../files/reveal.js';
```

`darwin.ts` — move today's behavior in (lifted verbatim from `files/reveal.ts` and `routes/state.ts`):

```ts
import { isLoopbackAddress, isLoopbackHost } from '../files/reveal.js';
// inside export const darwin: Platform = { ...
  flavor: 'macos',
  fileManagerName: 'Finder',
  revealInFileManager: (absPaths) =>
    new Promise((resolve, reject) =>
      execFile('/usr/bin/open', ['-R', ...absPaths], { timeout: 3000 }, (err) => (err ? reject(err) : resolve()))),
  isLocalClient: (c) => !c.proxied && isLoopbackAddress(c.remoteAddress) && isLoopbackHost(c.host),
  toolPlatformKey: () => (process.arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64'),
  tailscaleStatus: async () => { /* move the exec + JSON.parse body of routes/state.ts GET /tailscale here, returning {ip,hostname,online} and {ip:null,hostname:null,online:false} on any error */ },
```

(`execFile` from `child_process` is already imported in `darwin.ts`; `revealInFinder`'s argument-array + absolute-binary-path rationale comes with it as a comment.)

`linux.ts` — extend the spread:

```ts
export const linux: Platform = {
  ...darwin,
  id: 'linux',
  flavor: 'linux',
  fileManagerName: null,
  revealInFileManager: async () => { throw new Error('Reveal is not supported on headless Linux.'); },
  toolPlatformKey: () => (process.arch === 'arm64' ? 'linux-arm64' : 'linux-x64'),
  tailscaleStatus: async () => ({ ip: null, hostname: null, online: false }),
  logDir: () => path.join(os.homedir(), '.dispatch', 'logs'),
  daemon: linuxDaemonUnsupported,
};
```

(`isLocalClient` inherits darwin's loopback rule via the spread — correct for both.)

- [ ] **Step 4: Run tests** — `npx vitest run tests/platform` → PASS; `npx tsc -b` clean (proves `wsl.ts`'s spread still satisfies `Platform`).
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(platform): host-integration capabilities on darwin/linux (reveal, localness, tool keys, tailscale)"`

---

### Task 6: WSL capability overrides — `wslpath` + `explorer.exe`, gateway localness, interop tailscale

**Files:**
- Modify: `packages/core/src/platform/wsl.ts`
- Test: `packages/core/tests/platform/wsl.test.ts` (extend)

**Interfaces:**
- Produces: `parseDefaultGateway(routeFileText: string): string | null` (exported for tests). `createWslPlatform(deps)` now returns overrides for `flavor`/`fileManagerName`/`revealInFileManager`/`isLocalClient`/`tailscaleStatus`.

- [ ] **Step 1: Write the failing tests**

```ts
// append to tests/platform/wsl.test.ts
import { parseDefaultGateway } from '../../src/platform/wsl.js';

const ROUTE = `Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT
eth0\t00000000\t0120A8C0\t0003\t0\t0\t0\t00000000\t0\t0\t0
eth0\t0020A8C0\t00000000\t0001\t0\t0\t0\t00FFFFFF\t0\t0\t0`;

test('parseDefaultGateway decodes little-endian hex', () => {
  expect(parseDefaultGateway(ROUTE)).toBe('192.168.32.1');
});
test('parseDefaultGateway null when no default route', () => {
  expect(parseDefaultGateway(ROUTE.split('\n').filter((l) => !l.includes('00000000\t0120A8C0')).join('\n'))).toBeNull();
});

function fakeWsl(calls: string[][], gw = ROUTE) {
  return createWslPlatform({
    execFile: async (cmd, args) => {
      calls.push([cmd, ...args]);
      if (cmd === 'wslpath') return { stdout: 'C:\\Users\\dw\\proj\\file.txt\n' };
      return { stdout: '' };
    },
    readFileSync: (p) => (p === '/proc/net/route' ? gw : 'Linux version 5.15-microsoft'),
    env: { WSL_DISTRO_NAME: 'Ubuntu' } as NodeJS.ProcessEnv,
  });
}

test('reveal translates via wslpath and invokes explorer.exe /select', async () => {
  const calls: string[][] = [];
  await fakeWsl(calls).revealInFileManager(['/home/dw/proj/file.txt']);
  expect(calls).toEqual([
    ['wslpath', '-w', '/home/dw/proj/file.txt'],
    ['explorer.exe', '/select,C:\\Users\\dw\\proj\\file.txt'],
  ]);
});
test('explorer.exe nonzero exit is swallowed (it exits 1 on success)', async () => {
  const p = createWslPlatform({
    execFile: async (cmd, args) => {
      if (cmd === 'explorer.exe') { const e: any = new Error('exit 1'); e.code = 1; throw e; }
      return { stdout: 'C:\\x\n' };
    },
    readFileSync: () => ROUTE, env: {} as NodeJS.ProcessEnv,
  });
  await expect(p.revealInFileManager(['/x'])).resolves.toBeUndefined();
});
test('isLocalClient: NAT gateway peer with localhost Host accepted; portproxy LAN refused; tunnel refused', () => {
  const p = fakeWsl([]);
  expect(p.isLocalClient({ remoteAddress: '192.168.32.1', host: 'localhost:3456', proxied: false })).toBe(true);
  expect(p.isLocalClient({ remoteAddress: '127.0.0.1', host: 'localhost:3456', proxied: false })).toBe(true);   // mirrored mode
  expect(p.isLocalClient({ remoteAddress: '192.168.32.1', host: '192.168.1.5:3456', proxied: false })).toBe(false); // portproxy
  expect(p.isLocalClient({ remoteAddress: '192.168.32.1', host: 'localhost:3456', proxied: true })).toBe(false);    // tunnel
});
test('fileManagerName is File Explorer', () => expect(fakeWsl([]).fileManagerName).toBe('File Explorer'));
```

- [ ] **Step 2: Run to verify failure** → FAIL (`parseDefaultGateway` not exported; reveal inherited from linux throws).
- [ ] **Step 3: Implement in `wsl.ts`**

```ts
/** /proc/net/route stores IPv4 as little-endian hex: 0120A8C0 → C0.A8.20.01 → 192.168.32.1. */
export function parseDefaultGateway(routeText: string): string | null {
  for (const line of routeText.split('\n').slice(1)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length >= 3 && cols[1] === '00000000' && cols[2] !== '00000000') {
      const hex = cols[2];
      const octets = [hex.slice(6, 8), hex.slice(4, 6), hex.slice(2, 4), hex.slice(0, 2)]
        .map((h) => parseInt(h, 16));
      if (octets.every((o) => Number.isInteger(o))) return octets.join('.');
    }
  }
  return null;
}

export function createWslPlatform(deps: WslDeps = defaultDeps): Platform {
  let gateway: string | null | undefined; // cached; undefined = unread
  const readGateway = () => {
    if (gateway === undefined) {
      try { gateway = parseDefaultGateway(deps.readFileSync('/proc/net/route')); } catch { gateway = null; }
    }
    return gateway;
  };
  return {
    ...linux,
    flavor: 'wsl',
    fileManagerName: 'File Explorer',
    // explorer.exe /select, accepts ONE path (unlike `open -R`); reveal the first.
    // The macOS multi-select rationale (Finder Cmd-C into upload fields) has a native
    // Windows equivalent: dragging from Explorer into the browser works directly.
    revealInFileManager: async (absPaths) => {
      const { stdout } = await deps.execFile('wslpath', ['-w', absPaths[0]]);
      try {
        await deps.execFile('explorer.exe', ['/select,' + stdout.trim()]);
      } catch (err) {
        // explorer.exe exits 1 even on success; only surface spawn failures (ENOENT = no interop).
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw err;
      }
    },
    // Windows-host browser over WSL NAT arrives from the gateway IP, not loopback.
    // Host-header + proxy-header discipline still refuses portproxy'd LAN and tunnels.
    isLocalClient: (c) =>
      !c.proxied && isLoopbackHost(c.host) &&
      (isLoopbackAddress(c.remoteAddress) || (!!readGateway() && c.remoteAddress?.replace(/^::ffff:/, '') === readGateway())),
    tailscaleStatus: async () => {
      for (const bin of ['tailscale', 'tailscale.exe']) {
        try {
          const { stdout } = await deps.execFile(bin, ['status', '--json']);
          const s = JSON.parse(stdout);
          const self = s.Self ?? {};
          return { ip: self.TailscaleIPs?.[0] ?? null, hostname: self.HostName ?? null, online: !!self.Online };
        } catch { /* try next */ }
      }
      return { ip: null, hostname: null, online: false };
    },
  };
}
```

Add `import { isLoopbackAddress, isLoopbackHost } from '../files/reveal.js';`.

- [ ] **Step 4: Run tests** — `npx vitest run tests/platform` → PASS.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(platform): wsl interop capabilities — explorer reveal, gateway localness, tailscale"`

---

### Task 7: Conformance suite — the parity ratchet

**Files:**
- Test: `packages/core/tests/platform/conformance.test.ts`

**Interfaces:** Consumes all three platforms; no production code.

- [ ] **Step 1: Write the suite (it should pass immediately — its value is failing when a future method is missing)**

```ts
// packages/core/tests/platform/conformance.test.ts
import { describe, test, expect } from 'vitest';
import { darwin } from '../../src/platform/darwin.js';
import { linux } from '../../src/platform/linux.js';
import { createWslPlatform } from '../../src/platform/wsl.js';

const wsl = createWslPlatform({
  execFile: async () => ({ stdout: '' }),
  readFileSync: () => '', env: {} as NodeJS.ProcessEnv,
});

// Every capability the app relies on. Adding a Platform method without listing it
// here fails the exhaustiveness check below — update BOTH, for all platforms.
const CONTRACT = [
  'id', 'flavor', 'fileManagerName', 'defaultShell', 'resolveLoginPath', 'dataDir', 'logDir',
  'resolveCommand', 'listProcessIds', 'claudeProjectDir', 'installBrowserShim', 'daemon',
  'revealInFileManager', 'isLocalClient', 'toolPlatformKey', 'tailscaleStatus',
] as const;

describe.each([['darwin', darwin], ['linux', linux], ['wsl', wsl]] as const)('%s conforms', (_name, p) => {
  test('implements every contract key', () => {
    for (const key of CONTRACT) expect(p[key], `missing ${key}`).toBeDefined();
  });
  test('no keys beyond the contract (exhaustiveness — update CONTRACT and every impl together)', () => {
    expect(Object.keys(p).sort()).toEqual([...CONTRACT].sort());
  });
  test('shared invariants', () => {
    expect(p.dataDir()).toMatch(/\.dispatch$/);
    expect(['macos', 'wsl', 'linux']).toContain(p.flavor);
    expect(p.isLocalClient({ remoteAddress: '8.8.8.8', host: 'evil.com', proxied: false })).toBe(false);
    expect(p.isLocalClient({ remoteAddress: '127.0.0.1', host: 'localhost', proxied: true })).toBe(false);
  });
});
```

- [ ] **Step 2: Run** — `npx vitest run tests/platform/conformance.test.ts` → PASS. Temporarily delete `toolPlatformKey` from `linux.ts`, run again → the exhaustiveness test FAILS (proves the ratchet bites); restore it.
- [ ] **Step 3: Commit** — `git add -A && git commit -m "test(platform): conformance suite enforcing capability parity across darwin/linux/wsl"`

---

### Task 8: Rewire reveal + host + tailscale routes through the platform

**Files:**
- Modify: `packages/core/src/files/reveal.ts` (delete `canReveal` + `revealInFinder`; keep `isLoopbackAddress`, `isLoopbackHost`, `RevealClient`, `revealClientFrom`)
- Modify: `packages/core/src/routes/files.ts` (reveal endpoint), `packages/core/src/routes/state.ts` (`/host`, `/tailscale`)
- Test: `packages/core/tests/routes/state-host.test.ts` (update), `packages/core/tests/files/reveal.test.ts` (trim), `packages/core/tests/routes/files.test.ts` (update)

**Interfaces:**
- Produces: `GET /api/state/host` → `{ platform, flavor, fileManagerName, canReveal }`; reveal route guards with `platform.fileManagerName !== null && platform.isLocalClient(...)` and calls `platform.revealInFileManager(paths)`.

- [ ] **Step 1: Update the tests first.** In `state-host.test.ts`, replace the darwin-coupled assertion (`canReveal === (process.platform === 'darwin')`) with:

```ts
expect(res.body.flavor).toBe(platform.flavor);
expect(res.body.fileManagerName).toBe(platform.fileManagerName);
expect(typeof res.body.canReveal).toBe('boolean');
```

In `routes/files.test.ts`, the reveal cases mock `platform.revealInFileManager` (via `vi.spyOn`) instead of the removed `revealInFinder`. Run → FAIL.

- [ ] **Step 2: Implement.** `routes/state.ts` `/host`:

```ts
router.get('/host', (req, res) => {
  const client = revealClientFrom(req);
  res.json({
    platform: process.platform,
    flavor: platform.flavor,
    fileManagerName: platform.fileManagerName,
    canReveal: platform.fileManagerName !== null && platform.isLocalClient(client),
  });
});
```

`/tailscale` body becomes `res.json(await platform.tailscaleStatus())`. `routes/files.ts` reveal endpoint: guard with the same `canReveal` expression (403 on failure, matching today's semantics) and `await platform.revealInFileManager(resolved)`. Delete `canReveal`/`revealInFinder` from `files/reveal.ts` and their now-dead tests (the loopback-helper tests stay).

- [ ] **Step 3: Full core suite** — `npx vitest run` from `packages/core` → PASS.
- [ ] **Step 4: Commit** — `git add -A && git commit -m "refactor(core): reveal/host/tailscale routes speak through the platform layer"`

---

### Task 9: Tool downloads for Linux

**Files:**
- Modify: `packages/core/src/tools/paths.ts` (`hostPlatformKey` delegates to `platform.toolPlatformKey()`), `packages/core/src/tools/default-tools.json` (add `linux-x64` + `linux-arm64` rows)
- Test: `packages/core/tests/tools/paths.test.ts`, `packages/core/tests/tools/manifest.test.ts`

- [ ] **Step 1: Failing test** — in `paths.test.ts`: `expect(hostPlatformKey()).toBe(platform.toolPlatformKey())`; in `manifest.test.ts`: every tool in `default-tools.json` has `linux-x64` and `linux-arm64` entries with 64-char sha256. Run → FAIL.
- [ ] **Step 2: Implement.** `paths.ts`:

```ts
import { platform } from '../platform/index.js';
export function hostPlatformKey(): string { return platform.toolPlatformKey(); }
```

For each of jq/ripgrep/gh/doppler/databricks add rows mirroring the darwin ones with the vendors' Linux artifacts at the SAME pinned versions (jq 1.7.1 `jq-linux-amd64`/`jq-linux-arm64`; ripgrep 14.1.1 `x86_64-unknown-linux-musl`/`aarch64-unknown-linux-gnu` tarballs; gh 2.95.0 `linux_amd64`/`linux_arm64` tar.gz — note `binPath` inside; doppler 3.76.0 `linux_amd64`/`linux_arm64`; databricks 1.5.0 `linux_amd64`/`linux_arm64`). Compute each sha256 honestly:

```bash
curl -sL <url> | shasum -a 256   # paste the result into the JSON — never guess
```

- [ ] **Step 3: Run** — `npx vitest run tests/tools` → PASS.
- [ ] **Step 4: Commit** — `git add -A && git commit -m "feat(tools): linux-x64/arm64 download matrix; platform-keyed lookup"`

---

### Task 10: WSL daemon controller — Windows logon task via interop, in-place restart

**Files:**
- Create: `packages/core/src/platform/daemon-wsl.ts`
- Modify: `packages/core/src/platform/wsl.ts` (use it), `packages/core/src/server.ts` (write pidfile)
- Test: `packages/core/tests/platform/daemon-wsl.test.ts`

**Interfaces:**
- Produces: `createWslDaemon(deps): DaemonController`. `install()` persists `DaemonInstallOptions` to `<dataDir>/daemon.json` and registers scheduled task `Dispatch` via `schtasks.exe`; `restart()` kills the pid in `<dataDir>/daemon.pid`, waits for exit, respawns `node <entry>` detached from `daemon.json`. `server.ts` writes `daemon.pid` (its own pid) at startup and removes it in cleanup.

- [ ] **Step 1: Failing tests**

```ts
// packages/core/tests/platform/daemon-wsl.test.ts
import { describe, test, expect, vi } from 'vitest';
import { createWslDaemon } from '../../src/platform/daemon-wsl.js';

function harness(files: Record<string, string> = {}) {
  const calls: string[][] = [];
  const spawned: string[][] = [];
  const killed: number[] = [];
  const daemon = createWslDaemon({
    dataDir: () => '/fake/.dispatch',
    execFileSync: (cmd, args) => { calls.push([cmd, ...args]); return ''; },
    readFile: (p) => { if (!(p in files)) throw new Error('ENOENT'); return files[p]; },
    writeFile: (p, s) => { files[p] = s; },
    unlink: (p) => { delete files[p]; },
    spawnDetached: (cmd, args) => { spawned.push([cmd, ...args]); },
    kill: (pid, sig) => {
      if (sig === 0 && killed.includes(pid)) throw new Error('ESRCH');
      if (sig !== 0) killed.push(pid);
    },
    env: { WSL_DISTRO_NAME: 'Ubuntu' } as NodeJS.ProcessEnv,
  });
  return { daemon, calls, spawned, killed, files };
}

const OPTS = { port: 3456, nodePath: '/usr/bin/node', entry: '/repo/packages/core/dist/server.js', repoRoot: '/repo', env: {}, logDir: '/fake/logs' };

test('install registers an ONLOGON schtask running wsl.exe --exec and persists daemon.json', () => {
  const { daemon, calls, files } = harness();
  daemon.install(OPTS);
  expect(calls[0][0]).toBe('schtasks.exe');
  expect(calls[0]).toContain('/SC');
  expect(calls[0]).toContain('ONLOGON');
  const tr = calls[0][calls[0].indexOf('/TR') + 1];
  expect(tr).toContain('wsl.exe -d Ubuntu --exec /repo/bin/dispatch daemon-run');
  expect(JSON.parse(files['/fake/.dispatch/daemon.json']).entry).toBe(OPTS.entry);
});
test('uninstall deletes the task', () => {
  const { daemon, calls } = harness();
  daemon.uninstall();
  expect(calls[0]).toEqual(['schtasks.exe', '/Delete', '/F', '/TN', 'Dispatch']);
});
test('restart kills the recorded pid then respawns from daemon.json', () => {
  const { daemon, spawned, killed, files } = harness({
    '/fake/.dispatch/daemon.pid': '4242',
    '/fake/.dispatch/daemon.json': JSON.stringify(OPTS),
  });
  daemon.restart();
  expect(killed).toContain(4242);
  expect(spawned[0]).toEqual(['/usr/bin/node', '/repo/packages/core/dist/server.js']);
});
test('status reads the pidfile and probes liveness', () => {
  const { daemon } = harness({ '/fake/.dispatch/daemon.pid': '4242' });
  expect(daemon.status()).toEqual({ loaded: true, pid: 4242 });
});
```

- [ ] **Step 2: Run** → FAIL (module missing).
- [ ] **Step 3: Implement `daemon-wsl.ts`**

```ts
import path from 'path';
import type { DaemonController, DaemonInstallOptions } from './daemon.js';

export interface WslDaemonDeps {
  dataDir(): string;
  execFileSync(cmd: string, args: string[]): string;
  readFile(p: string): string;
  writeFile(p: string, s: string): void;
  unlink(p: string): void;
  spawnDetached(cmd: string, args: string[]): void;
  kill(pid: number, sig: number | NodeJS.Signals): void;
  env: NodeJS.ProcessEnv;
}

const TASK = 'Dispatch';

export function createWslDaemon(d: WslDaemonDeps): DaemonController {
  const pidFile = () => path.join(d.dataDir(), 'daemon.pid');
  const optsFile = () => path.join(d.dataDir(), 'daemon.json');
  const readPid = (): number | null => {
    try { const n = parseInt(d.readFile(pidFile()).trim(), 10); return Number.isInteger(n) ? n : null; }
    catch { return null; }
  };
  const alive = (pid: number) => { try { d.kill(pid, 0); return true; } catch { return false; } };

  return {
    install(opts: DaemonInstallOptions) {
      d.writeFile(optsFile(), JSON.stringify(opts));
      const distro = d.env.WSL_DISTRO_NAME ?? 'Ubuntu';
      // The wsl.exe process anchors the distro VM's lifetime AND the daemon's interop context.
      const tr = `wsl.exe -d ${distro} --exec ${opts.repoRoot}/bin/dispatch daemon-run`;
      d.execFileSync('schtasks.exe', ['/Create', '/F', '/SC', 'ONLOGON', '/TN', TASK, '/TR', tr]);
      d.execFileSync('schtasks.exe', ['/Run', '/TN', TASK]);
    },
    uninstall() { d.execFileSync('schtasks.exe', ['/Delete', '/F', '/TN', TASK]); },
    start() { d.execFileSync('schtasks.exe', ['/Run', '/TN', TASK]); },
    stop() { const pid = readPid(); if (pid) d.kill(pid, 'SIGTERM'); },
    restart() {
      const pid = readPid();
      if (pid) {
        d.kill(pid, 'SIGTERM');
        const until = Date.now() + 5000;
        while (alive(pid) && Date.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
      }
      const opts = JSON.parse(d.readFile(optsFile())) as DaemonInstallOptions;
      d.spawnDetached(opts.nodePath, [opts.entry]);
    },
    status() { const pid = readPid(); return pid && alive(pid) ? { loaded: true, pid } : { loaded: false }; },
  };
}
```

Default deps (fs/child_process-backed, `spawnDetached` = `spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref()`) live beside it; `wsl.ts` sets `daemon: createWslDaemon(defaultWslDaemonDeps)`. `DaemonInstallOptions` gains `repoRoot` if the branch version lacks it (check `daemon.ts` — it has it).

- [ ] **Step 4: pidfile in `server.ts`** — in `startServer` after the data-dir mkdir: `fs.writeFileSync(path.join(dataDir, 'daemon.pid'), String(process.pid));` and in the returned `cleanup`: `try { fs.unlinkSync(path.join(dataDir, 'daemon.pid')); } catch {}`. Add `daemon-run` as an alias of `run` in `packages/cli/src/index.ts` `main()`'s command switch.
- [ ] **Step 5: Run** — `npx vitest run tests/platform` (core) and `cd ../cli && npx vitest run` → PASS. Full core suite → PASS.
- [ ] **Step 6: Commit** — `git add -A && git commit -m "feat(platform): wsl daemon controller — logon schtask via interop, pidfile in-place restart"`

---

### Task 11: Self-update restart path on WSL

**Files:**
- Modify: `packages/cli/src/index.ts` (`cmdUpdate`)
- Test: `packages/cli/tests/commands.test.ts`

**Interfaces:** Consumes `platform.daemon.restart()` (Task 10). `update/apply.ts` is untouched — it already spawns `bin/dispatch update` detached.

- [ ] **Step 1: Failing test** — assert `cmdUpdate` on a non-darwin platform calls `platform.daemon.restart()` after build (mock the platform import with `vi.mock`; assert order: git pull → build → restart). Follow the mocking pattern already used in `commands.test.ts` for `cmdBuild`.
- [ ] **Step 2: Implement** — `cmdUpdate` today shells the darwin restart; change its tail to `platform.daemon.restart()` unconditionally (darwin's controller already wraps launchctl kickstart — one code path, three behaviors).
- [ ] **Step 3: Run** — `cd packages/cli && npx vitest run` → PASS.
- [ ] **Step 4: Commit** — `git add -A && git commit -m "feat(cli): update restarts via the platform daemon controller"`

---

### Task 12: Installers + guardrails + bring-up doc

**Files:**
- Create: `scripts/install-windows.ps1`, `docs/wsl2-bring-up.md`
- Modify: `scripts/install.sh` (allow Linux), `packages/core/src/routes/sessions.ts` (POST handler: `/mnt/*` warning)
- Test: `packages/core/tests/routes/sessions.test.ts` (extend)

- [ ] **Step 1: `/mnt` warning, test-first.** In the sessions route test file, POST a session with `workingDir: '/mnt/c/Users/x/proj'` and assert the 200 response includes `warning` matching `/mnt.*slow/i` while a `/home`-rooted request has no `warning`. Implement in the POST handler:

```ts
const warning = req.body.workingDir?.startsWith('/mnt/')
  ? 'This project lives on the Windows filesystem (/mnt/*): expect slow file I/O and case-insensitive names. Prefer a path inside the Linux filesystem (~/…).'
  : undefined;
// include in the res.json payload: { ...session, ...(warning ? { warning } : {}) }
```

- [ ] **Step 2: `scripts/install-windows.ps1`** (stage 1 — idempotent, resumable):

```powershell
#Requires -Version 5
# Dispatch bootstrap: ensures WSL2 + Ubuntu, then runs the Linux installer inside it.
$ErrorActionPreference = 'Stop'
$distro = 'Ubuntu'
function Test-Wsl { try { wsl.exe --status *> $null; return $LASTEXITCODE -eq 0 } catch { return $false } }
if (-not (Test-Wsl)) {
  Write-Host 'Installing WSL2 (this can require a reboot — re-run this script afterwards)...'
  wsl.exe --install -d $distro
  exit 0
}
$distros = (wsl.exe -l -q) -join "`n"
if ($distros -notmatch [regex]::Escape($distro)) {
  wsl.exe --install -d $distro
  Write-Host "Ubuntu is installing. Complete its first-run user setup, then re-run this script."
  exit 0
}
Write-Host 'WSL2 ready — installing Dispatch inside Ubuntu...'
wsl.exe -d $distro -- bash -lc 'git clone https://github.com/davidwebber10/dispatch.git ~/dispatch 2>/dev/null || git -C ~/dispatch pull; cd ~/dispatch && ./scripts/install.sh'
Write-Host 'Done. Open http://localhost:3456'
```

- [ ] **Step 3: `scripts/install.sh`** — replace the Darwin hard-fail with:

```bash
case "$(uname)" in
  Darwin|Linux) ;;
  *) red "Dispatch supports macOS and Linux/WSL2 (on Windows, run scripts/install-windows.ps1)."; exit 1 ;;
esac
```

(the rest of the script already funnels into `bin/dispatch install`, which is now cross-platform; on wsl the platform daemon registers the logon task itself — Task 10.)

- [ ] **Step 4: `docs/wsl2-bring-up.md`** — write the Tier-3 checklist verbatim from the spec's Testing section: stage-1 installer (including the reboot resume path), logon task boots daemon after sign-out/in, `http://localhost:3456` from the Windows browser shows Reveal, reveal pops Explorer for a `~/...` path (lands on `\\wsl.localhost\Ubuntu\...`) and an `/mnt/c/...` path, update/apply restarts in place (version bump visible, pid changes, survives the old `wsl.exe` anchor exiting — record the observed behavior), phone via Tailscale works and does NOT show Reveal, cloud-VM notes (Azure Dv5-class has nested virtualization).
- [ ] **Step 5: Run route tests + commit**

Run: `cd packages/core && npx vitest run tests/routes/sessions.test.ts` → PASS.

```bash
git add -A && git commit -m "feat(install): Windows bootstrap via WSL2, Linux install path, /mnt warning, bring-up checklist"
```

---

### Task 13: Web — server-driven reveal wording

**Files:**
- Modify: `packages/web/src/api/client.ts:116` (getHost type), `packages/web/src/stores/host.ts`, `packages/web/src/components/inspector/FilesPane.tsx:327`
- Test: `packages/web/src/components/inspector/FilesPane.test.tsx` (or create alongside)

- [ ] **Step 1: Failing test** — render FilesPane's reveal control with the host store seeded `{ canReveal: true, fileManagerName: 'File Explorer' }` and assert `screen.getByText('Reveal in File Explorer')`; with `fileManagerName: 'Finder'` assert `'Reveal in Finder'`. Follow the store-seeding pattern used by existing FilesPane tests (`useHost.setState`).
- [ ] **Step 2: Implement** — `client.ts`: `getHost: () => req<{ platform: string; flavor: 'macos' | 'wsl' | 'linux'; fileManagerName: string | null; canReveal: boolean }>('/api/state/host')`. `stores/host.ts`: add `fileManagerName: string | null` (default `null`), set it in the fetch handler, reset on error. `FilesPane.tsx:327`: `<FolderOpen size={15} /> Reveal in {fileManagerName}` (the `canReveal &&` guard at line 324 already hides it when the server says no; `fileManagerName` is non-null whenever `canReveal` is true — server guarantees it).
- [ ] **Step 3: Run** — `cd packages/web && npx vitest run` → PASS.
- [ ] **Step 4: Commit** — `git add -A && git commit -m "feat(web): reveal wording follows the daemon's file manager"`

---

### Task 14: Web — modifier keys follow the browser's OS

**Files:**
- Create: `packages/web/src/lib/hostkeys.ts`
- Modify: every `metaKey`/`⌘` site: `packages/web/src/components/layout/EmptyWorkspace.tsx`, `packages/web/src/components/overseer/components/Composer.tsx`, `packages/web/src/components/inspector/FilesPane.tsx`, `packages/web/src/components/tabs/FileEditorTab.tsx`, `packages/web/src/components/tabs/TerminalTab.tsx` (find each with `rg -n 'metaKey|⌘' src --glob '!*.test.*'`)
- Test: `packages/web/src/lib/hostkeys.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { test, expect } from 'vitest';
import { isMacLike, primaryMod, modLabel } from './hostkeys';

test('mac-like detection from platform string', () => {
  expect(isMacLike('MacIntel')).toBe(true);
  expect(isMacLike('iPhone')).toBe(true);
  expect(isMacLike('Win32')).toBe(false);
  expect(isMacLike('Linux x86_64')).toBe(false);
});
test('primaryMod picks metaKey on mac, ctrlKey elsewhere', () => {
  expect(primaryMod({ metaKey: true, ctrlKey: false } as KeyboardEvent, 'MacIntel')).toBe(true);
  expect(primaryMod({ metaKey: false, ctrlKey: true } as KeyboardEvent, 'Win32')).toBe(true);
  expect(primaryMod({ metaKey: true, ctrlKey: false } as KeyboardEvent, 'Win32')).toBe(false);
});
test('modLabel renders the right prefix', () => {
  expect(modLabel('N', 'MacIntel')).toBe('⌘N');
  expect(modLabel('N', 'Win32')).toBe('Ctrl+N');
});
```

- [ ] **Step 2: Implement `hostkeys.ts`**

```ts
/** Modifier conventions follow the BROWSER's OS, not the daemon's — a Mac user
 *  browsing a WSL daemon still expects ⌘. */
export function isMacLike(plat: string = navigator.platform): boolean {
  return /Mac|iPhone|iPad|iPod/.test(plat);
}
export function primaryMod(e: { metaKey: boolean; ctrlKey: boolean }, plat?: string): boolean {
  return isMacLike(plat) ? e.metaKey : e.ctrlKey;
}
export function modLabel(key: string, plat?: string): string {
  return isMacLike(plat) ? `⌘${key}` : `Ctrl+${key}`;
}
```

- [ ] **Step 3: Apply at every site.** Transformation rules — hint strings: `'⌘N'` → `modLabel('N')`; handlers: `e.metaKey && e.key === 'n'` → `primaryMod(e) && e.key === 'n'`. Where a handler currently accepts `e.metaKey || e.ctrlKey` (some already do), leave it — that's a superset and already Windows-friendly. Do not touch `useTabCycleShortcut` (Ctrl+Tab is deliberately Ctrl on every OS).
- [ ] **Step 4: Run the full web suite** — `cd packages/web && npx vitest run` → PASS (fix any test asserting literal '⌘' by seeding `navigator.platform` via `vi.stubGlobal`).
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(web): keyboard hints and accelerators follow the browser OS"`

---

### Task 15: Tier-2 Docker harness — fake-WSL integration

**Files:**
- Create: `scripts/wsl-sim/wslpath`, `scripts/wsl-sim/explorer.exe`, `scripts/wsl-sim/schtasks.exe`, `scripts/wsl-sim/wsl.exe` (sh shims), `scripts/test-wsl-docker.sh`

- [ ] **Step 1: Write the shims.** Each is a 3-line sh script on the container's PATH that logs argv and answers plausibly:

```sh
#!/bin/sh
# scripts/wsl-sim/wslpath — log and fake-translate
echo "wslpath $*" >> "$WSL_SIM_LOG"
echo "C:\\wslsim$(echo "$2" | tr '/' '\\')"
```

```sh
#!/bin/sh
# scripts/wsl-sim/explorer.exe — log and mimic explorer's exit-1-on-success quirk
echo "explorer.exe $*" >> "$WSL_SIM_LOG"
exit 1
```

(`schtasks.exe` and `wsl.exe` log and `exit 0`.)

- [ ] **Step 2: Write `scripts/test-wsl-docker.sh`** — runs an `node:22-bookworm` container mounting the repo, with `WSL_DISTRO_NAME=Ubuntu`, `PATH="/repo/scripts/wsl-sim:$PATH"`, `WSL_SIM_LOG=/tmp/simlog`; inside: build, launch the daemon on port 3999 with a fake HOME, `curl -s localhost:3999/api/state/host` and assert `"flavor":"wsl"` + `"fileManagerName":"File Explorer"`, create a session + POST a reveal with `Host: localhost:3999` (assert 200 in mirrored-style loopback), then `grep 'explorer.exe' /tmp/simlog` and `grep 'wslpath -w' /tmp/simlog`. Exit nonzero on any failed assertion. (~40 lines; mirror the curl recipe in `.claude/skills/verify/SKILL.md`.)
- [ ] **Step 3: Run it** — `./scripts/test-wsl-docker.sh` on the Mac (Docker required)
Expected: `WSL-SIM: all assertions passed`.
- [ ] **Step 4: Commit** — `git add -A && git commit -m "test(wsl): dockerized fake-WSL integration harness (tier 2)"`

> CI note: the existing `ci.yml` job already runs on `ubuntu-latest`, so every unit/conformance/wsl test added above runs on Linux on every push — the anti-afterthought gate needs no workflow change. The Docker harness stays a local/manual tier (CI runners can run it later if wanted).

---

## Self-Review (performed)

- **Spec coverage:** Phase 0 → Tasks 1–3; flavor + parity methods → 4–7; reveal/host/tools rewiring → 8–9; lifecycle + install + self-update → 10–12; UI translation → 13–14; Tier-2 harness + CI → 15 (CI pre-exists on ubuntu-latest); Tier-3 checklist → Task 12's bring-up doc. Deviations from spec, both deliberate: `detectTunnels` shipped as `tailscaleStatus` (the only consumer is the tailscale route), and WSL reveal selects the first path only (`explorer.exe /select,` is single-path; noted in code comment).
- **Placeholder scan:** the two "follow the branch diff" steps (Task 3) and "mirror existing test patterns" steps (Tasks 11, 13) reference concrete, checked-in artifacts by exact path — reviewable, not placeholders.
- **Type consistency:** `RevealClient` stays the shared client shape (`files/reveal.ts`); `TailscaleStatus` defined once in `types.ts`; `DaemonInstallOptions.repoRoot` confirmed present in the branch's `daemon.ts`; `flavor` values `'macos' | 'wsl' | 'linux'` consistent across core `types.ts`, `/host` payload, and web `client.ts`.
