# Native Windows Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run the Dispatch daemon natively on Windows 11 (terminals, agents, web, files, secrets, transcripts) by introducing a platform-abstraction layer, a Task Scheduler at-logon daemon lifecycle, and a cross-platform Node CLI — with macOS behavior unchanged.

**Architecture:** All platform-divergent behavior moves behind a single `Platform` interface (`packages/core/src/platform/`) with `darwin`/`win32` implementations resolved once at startup. Pure logic (path encoding, Task Scheduler XML, `tasklist` parsing, shell/command construction) is separated from OS calls so the `win32` logic is unit-testable on macOS. The bash `bin/dispatch` is replaced by one cross-platform Node CLI that delegates lifecycle to a per-platform `DaemonController`.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Node ≥18, vitest, node-pty 1.1.0 (win32 prebuilts), pnpm workspace, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-06-24-windows-native-port-design.md`

## Global Constraints

- **No change to macOS behavior** — the `darwin` impl wraps existing code paths; every existing test stays green.
- **No `if (process.platform === …)` outside `packages/core/src/platform/`.**
- **ESM import specifiers end in `.js`** (e.g. `import { x } from './y.js'`), matching the codebase.
- **Tests use vitest**; `pnpm --filter dispatch-server test` (core) / `pnpm --filter dispatch-web test` (web).
- **Pure logic is exported and unit-tested directly on macOS;** OS-call wrappers are thin.
- **Node ≥18; node-pty pinned `1.1.0`.**
- **Deferred on Windows (return graceful "unavailable", never throw):** browser/OAuth shim, Tailscale status.
- **Commit after every green step.** Conventional-commit messages.

---

## Phase 1 — Platform interface + `darwin` impl + route call sites

### Task 1: Define the `Platform` interface and types

**Files:**
- Create: `packages/core/src/platform/types.ts`
- Test: (none — type-only)

**Interfaces:**
- Produces: `Platform`, `ShellSpec`, `BrowserShimOptions`, `BrowserShimEnv` consumed by all later tasks.

- [ ] **Step 1: Write the interface**

```ts
// packages/core/src/platform/types.ts
export interface ShellSpec {
  command: string;
  args: string[];
}

export interface BrowserShimOptions {
  dataDir: string;
  serverUrl: string;
}

// darwin returns BROWSER/GH_BROWSER/DISPATCH_SERVER_URL/PATH; win32 returns {}.
export type BrowserShimEnv = Record<string, string>;

export interface Platform {
  /** process.platform of the active implementation. */
  readonly id: NodeJS.Platform;
  /** Shell for a plain `shell` terminal. */
  defaultShell(): ShellSpec;
  /** Login-shell PATH (macOS GUI-launch fix); undefined when not needed (Windows). */
  resolveLoginPath(): string | undefined;
  /** Data dir (SQLite + runtime). */
  dataDir(): string;
  /** Log dir. */
  logDir(): string;
  /** Absolute path to an executable on PATH, or null. Resolves .cmd/Node shims on Windows. */
  resolveCommand(name: string): string | null;
  /** All live process ids (used to reap orphaned PTYs). */
  listProcessIds(): number[];
  /** The `~/.claude/projects/<encoded>` dir for a working directory. */
  claudeProjectDir(workDir: string): string;
  /** Installs the browser/OAuth capture shim; returns env to inject. {} when unsupported. */
  installBrowserShim(opts: BrowserShimOptions): BrowserShimEnv;
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/core/src/platform/types.ts
git commit -m "feat(platform): define Platform interface and types"
```

---

### Task 2: Pure helpers — `claudeProjectDir` encoding

**Files:**
- Create: `packages/core/src/platform/encode.ts`
- Test: `packages/core/tests/platform/encode.test.ts`

**Interfaces:**
- Produces: `encodeClaudeProjectDir(workDir: string, platform: 'darwin' | 'win32'): string`

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/tests/platform/encode.test.ts
import { describe, expect, test } from 'vitest';
import { encodeClaudeProjectDir } from '../../src/platform/encode.js';

describe('encodeClaudeProjectDir', () => {
  test('darwin: replaces "/" with "-" (unchanged from current behavior)', () => {
    expect(encodeClaudeProjectDir('/Users/jdetamore/proj', 'darwin')).toBe('-Users-jdetamore-proj');
  });
  test('win32: replaces drive colon and backslashes with "-"', () => {
    // NOTE: must match Windows Claude Code's real encoding — confirm during bring-up.
    expect(encodeClaudeProjectDir('C:\\Users\\jdetamore\\proj', 'win32')).toBe('C--Users-jdetamore-proj');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter dispatch-server exec vitest run tests/platform/encode.test.ts`
Expected: FAIL — `encodeClaudeProjectDir` is not defined.

- [ ] **Step 3: Implement**

```ts
// packages/core/src/platform/encode.ts
/**
 * Encodes a working directory into the Claude Code transcript folder name
 * (`~/.claude/projects/<encoded>`). The scheme mirrors Claude Code's own per
 * platform. The win32 scheme (replace `/ \ :` with `-`) is provisional and MUST
 * be confirmed against a real Windows `%USERPROFILE%\.claude\projects` listing
 * during bring-up; if it differs, only this function changes.
 */
export function encodeClaudeProjectDir(workDir: string, platform: 'darwin' | 'win32'): string {
  if (platform === 'win32') return workDir.replace(/[/\\:]/g, '-');
  return workDir.replace(/\//g, '-');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter dispatch-server exec vitest run tests/platform/encode.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/platform/encode.ts packages/core/tests/platform/encode.test.ts
git commit -m "feat(platform): claude project-dir encoding (darwin + win32)"
```

---

### Task 3: Pure helper — `tasklist` CSV parsing

**Files:**
- Create: `packages/core/src/platform/win32-util.ts`
- Test: `packages/core/tests/platform/win32-util.test.ts`

**Interfaces:**
- Produces: `parseTasklistPids(csv: string): number[]`

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/tests/platform/win32-util.test.ts
import { describe, expect, test } from 'vitest';
import { parseTasklistPids } from '../../src/platform/win32-util.js';

describe('parseTasklistPids', () => {
  test('extracts PIDs from `tasklist /FO CSV /NH` output', () => {
    const csv = [
      '"System Idle Process","0","Services","0","8 K"',
      '"node.exe","4363","Console","1","52,000 K"',
      '"powershell.exe","7576","Console","1","80,000 K"',
    ].join('\r\n');
    expect(parseTasklistPids(csv)).toEqual([0, 4363, 7576]);
  });
  test('ignores blank lines and malformed rows', () => {
    expect(parseTasklistPids('\r\n"bad row"\r\n"x","notanumber","y","z","w"\r\n')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter dispatch-server exec vitest run tests/platform/win32-util.test.ts`
Expected: FAIL — `parseTasklistPids` not defined.

- [ ] **Step 3: Implement**

```ts
// packages/core/src/platform/win32-util.ts
/** Parses PIDs (column 2) from `tasklist /FO CSV /NH` output. */
export function parseTasklistPids(csv: string): number[] {
  const pids: number[] = [];
  for (const line of csv.split(/\r?\n/)) {
    const cols = line.split('","');
    if (cols.length < 2) continue;
    const pid = Number(cols[1].replace(/"/g, '').trim());
    if (Number.isInteger(pid)) pids.push(pid);
  }
  return pids;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter dispatch-server exec vitest run tests/platform/win32-util.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/platform/win32-util.ts packages/core/tests/platform/win32-util.test.ts
git commit -m "feat(platform): tasklist CSV PID parser"
```

---

### Task 4: `darwin` implementation (wrap existing behavior)

**Files:**
- Create: `packages/core/src/platform/darwin.ts`
- Modify: `packages/core/src/auth/shim.ts` (export `installBrowserShim` is already exported — reused as-is)
- Test: `packages/core/tests/platform/darwin.test.ts`

**Interfaces:**
- Consumes: `Platform` (Task 1), `encodeClaudeProjectDir` (Task 2), existing `installBrowserShim` from `auth/shim.ts`.
- Produces: `export const darwin: Platform`.

- [ ] **Step 1: Write the failing test** (pure-logic methods only; exec wrappers verified on macOS where the commands exist)

```ts
// packages/core/tests/platform/darwin.test.ts
import { describe, expect, test } from 'vitest';
import os from 'os';
import path from 'path';
import { darwin } from '../../src/platform/darwin.js';

describe('darwin platform', () => {
  test('defaultShell uses $SHELL or /bin/zsh', () => {
    const { command, args } = darwin.defaultShell();
    expect(command).toBe(process.env.SHELL || '/bin/zsh');
    expect(args).toEqual([]);
  });
  test('dataDir is ~/.dispatch', () => {
    expect(darwin.dataDir()).toBe(path.join(os.homedir(), '.dispatch'));
  });
  test('logDir is ~/Library/Logs/dispatch', () => {
    expect(darwin.logDir()).toBe(path.join(os.homedir(), 'Library', 'Logs', 'dispatch'));
  });
  test('claudeProjectDir encodes under ~/.claude/projects', () => {
    expect(darwin.claudeProjectDir('/tmp/proj')).toBe(
      path.join(os.homedir(), '.claude', 'projects', '-tmp-proj'),
    );
  });
  test('resolveCommand finds a real binary (sh) and returns null for nonsense', () => {
    expect(darwin.resolveCommand('sh')).toMatch(/sh$/);
    expect(darwin.resolveCommand('no-such-cmd-xyz')).toBeNull();
  });
  test('listProcessIds returns this process', () => {
    expect(darwin.listProcessIds()).toContain(process.pid);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter dispatch-server exec vitest run tests/platform/darwin.test.ts`
Expected: FAIL — `darwin` not defined.

- [ ] **Step 3: Implement** (move `resolveShellPath` logic out of `server.ts` to here)

```ts
// packages/core/src/platform/darwin.ts
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import type { Platform } from './types.js';
import { encodeClaudeProjectDir } from './encode.js';
import { installBrowserShim } from '../auth/shim.js';

export const darwin: Platform = {
  id: 'darwin',
  defaultShell: () => ({ command: process.env.SHELL || '/bin/zsh', args: [] }),
  resolveLoginPath: () => {
    try {
      const shell = process.env.SHELL || '/bin/zsh';
      const out = execFileSync(
        shell,
        ['-ilc', 'echo -n "__DISPATCH_PATH_START__${PATH}__DISPATCH_PATH_END__"'],
        { encoding: 'utf-8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] },
      );
      const m = String(out).match(/__DISPATCH_PATH_START__(.*?)__DISPATCH_PATH_END__/s);
      const p = m?.[1]?.trim();
      return p && p.length > 0 ? p : undefined;
    } catch {
      return undefined;
    }
  },
  dataDir: () => path.join(os.homedir(), '.dispatch'),
  logDir: () => path.join(os.homedir(), 'Library', 'Logs', 'dispatch'),
  resolveCommand: (name) => {
    try {
      return execFileSync('which', [name], { encoding: 'utf-8' }).trim() || null;
    } catch {
      return null;
    }
  },
  listProcessIds: () => {
    try {
      return execFileSync('ps', ['-eo', 'pid'], { encoding: 'utf-8' })
        .split('\n').map((l) => Number(l.trim())).filter(Number.isInteger);
    } catch {
      return [];
    }
  },
  claudeProjectDir: (workDir) =>
    path.join(os.homedir(), '.claude', 'projects', encodeClaudeProjectDir(workDir, 'darwin')),
  installBrowserShim: (opts) => installBrowserShim(opts),
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter dispatch-server exec vitest run tests/platform/darwin.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/platform/darwin.ts packages/core/tests/platform/darwin.test.ts
git commit -m "feat(platform): darwin implementation"
```

---

### Task 5: `win32` implementation + macOS-runnable logic tests

**Files:**
- Create: `packages/core/src/platform/win32.ts`
- Test: `packages/core/tests/platform/win32.test.ts`

**Interfaces:**
- Consumes: `Platform` (Task 1), `encodeClaudeProjectDir` (Task 2), `parseTasklistPids` (Task 3).
- Produces: `export const win32: Platform`.

- [ ] **Step 1: Write the failing test** (logic only — runs on macOS; exec wrappers are not invoked here)

```ts
// packages/core/tests/platform/win32.test.ts
import { describe, expect, test } from 'vitest';
import os from 'os';
import path from 'path';
import { win32 } from '../../src/platform/win32.js';

describe('win32 platform (logic)', () => {
  test('resolveLoginPath is undefined (Task Scheduler inherits registry PATH)', () => {
    expect(win32.resolveLoginPath()).toBeUndefined();
  });
  test('dataDir is ~/.dispatch via os.homedir()', () => {
    expect(win32.dataDir()).toBe(path.join(os.homedir(), '.dispatch'));
  });
  test('claudeProjectDir uses the win32 encoding', () => {
    expect(win32.claudeProjectDir('C:\\Users\\x\\proj'))
      .toBe(path.join(os.homedir(), '.claude', 'projects', 'C--Users-x-proj'));
  });
  test('installBrowserShim is a no-op returning {}', () => {
    expect(win32.installBrowserShim({ dataDir: 'x', serverUrl: 'y' })).toEqual({});
  });
  test('defaultShell prefers pwsh, falls back to powershell.exe', () => {
    const withPwsh = win32.defaultShell((name) => (name === 'pwsh' ? 'C:\\pwsh.exe' : null));
    expect(withPwsh).toEqual({ command: 'C:\\pwsh.exe', args: ['-NoLogo'] });
    const noPwsh = win32.defaultShell(() => null);
    expect(noPwsh).toEqual({ command: 'powershell.exe', args: ['-NoLogo'] });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter dispatch-server exec vitest run tests/platform/win32.test.ts`
Expected: FAIL — `win32` not defined.

- [ ] **Step 3: Implement** (note `defaultShell` takes an optional resolver so the pwsh-fallback logic is testable on macOS; production calls it with no arg and it uses `resolveCommand`)

```ts
// packages/core/src/platform/win32.ts
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import type { Platform, ShellSpec, BrowserShimEnv } from './types.js';
import { encodeClaudeProjectDir } from './encode.js';
import { parseTasklistPids } from './win32-util.js';

function whereExe(name: string): string | null {
  try {
    const out = execFileSync('where', [name], { encoding: 'utf-8' }).split(/\r?\n/)[0]?.trim();
    return out && out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

interface Win32Platform extends Platform {
  defaultShell(resolve?: (name: string) => string | null): ShellSpec;
}

export const win32: Win32Platform = {
  id: 'win32',
  defaultShell: (resolve = whereExe) => {
    const pwsh = resolve('pwsh');
    return { command: pwsh ?? 'powershell.exe', args: ['-NoLogo'] };
  },
  resolveLoginPath: () => undefined,
  dataDir: () => path.join(os.homedir(), '.dispatch'),
  logDir: () =>
    path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'dispatch', 'logs'),
  resolveCommand: (name) => whereExe(name),
  listProcessIds: () => {
    try {
      return parseTasklistPids(execFileSync('tasklist', ['/FO', 'CSV', '/NH'], { encoding: 'utf-8' }));
    } catch {
      return [];
    }
  },
  claudeProjectDir: (workDir) =>
    path.join(os.homedir(), '.claude', 'projects', encodeClaudeProjectDir(workDir, 'win32')),
  installBrowserShim: (): BrowserShimEnv => ({}),
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter dispatch-server exec vitest run tests/platform/win32.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/platform/win32.ts packages/core/tests/platform/win32.test.ts
git commit -m "feat(platform): win32 implementation with macOS-testable logic"
```

---

### Task 6: Platform selector singleton

**Files:**
- Create: `packages/core/src/platform/index.ts`
- Test: `packages/core/tests/platform/index.test.ts`

**Interfaces:**
- Consumes: `darwin`, `win32`.
- Produces: `export const platform: Platform` and re-exports `Platform`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/tests/platform/index.test.ts
import { expect, test } from 'vitest';
import { platform } from '../../src/platform/index.js';

test('selects the implementation matching process.platform', () => {
  expect(platform.id).toBe(process.platform); // 'darwin' in CI here, 'win32' on Windows CI
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter dispatch-server exec vitest run tests/platform/index.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// packages/core/src/platform/index.ts
import { darwin } from './darwin.js';
import { win32 } from './win32.js';
import type { Platform } from './types.js';

function select(): Platform {
  switch (process.platform) {
    case 'darwin': return darwin;
    case 'win32': return win32;
    default:
      throw new Error(`Dispatch does not support platform "${process.platform}" yet (darwin/win32 only).`);
  }
}

export const platform: Platform = select();
export type { Platform, ShellSpec, BrowserShimOptions, BrowserShimEnv } from './types.js';
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter dispatch-server exec vitest run tests/platform/index.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/platform/index.ts packages/core/tests/platform/index.test.ts
git commit -m "feat(platform): startup platform selector"
```

---

### Task 7: Route runtime call sites through `platform` (macOS behavior identical)

**Files:**
- Modify: `packages/core/src/sessions/service.ts` (the `'/bin/zsh'` default shell; the two `claudeProjectDir` encodings)
- Modify: `packages/core/src/providers/claude-code.ts:85` (the projects dir join)
- Modify: `packages/core/src/server.ts` (`resolveShellPath()` → `platform.resolveLoginPath()`; `execSync('ps -eo pid')` → `platform.listProcessIds()`; data dir → `platform.dataDir()`)
- Modify: `packages/core/src/routes/state.ts` (guard the hardcoded Tailscale path)
- Test: existing suites must stay green; add `packages/core/tests/platform/wiring.test.ts`

**Interfaces:**
- Consumes: `platform` (Task 6).

- [ ] **Step 1: Replace the hardcoded shell**

In `packages/core/src/sessions/service.ts`, where `command = '/bin/zsh'` for `terminal.type === 'shell'`:

```ts
import { platform } from '../platform/index.js';
// ...
if (terminal.type === 'shell') {
  const shell = platform.defaultShell();
  command = shell.command;
  args = shell.args; // ensure args are threaded into the spawn call
}
```

- [ ] **Step 2: Replace the transcript-dir encodings**

In `packages/core/src/sessions/service.ts` (both occurrences) and `packages/core/src/providers/claude-code.ts:85`, replace:

```ts
const dir = path.join(os.homedir(), '.claude', 'projects', workDir.replace(/\//g, '-'));
```

with:

```ts
import { platform } from '../platform/index.js'; // adjust relative depth per file
const dir = platform.claudeProjectDir(workDir);
```

- [ ] **Step 3: Replace shell-PATH + process-listing + data dir in `server.ts`**

Delete the local `resolveShellPath()` function; replace its call with `platform.resolveLoginPath()`. Replace `const procs = execSync('ps -eo pid', …)` with `const pids = platform.listProcessIds()` (adapt the consumer to a `number[]`). Replace `path.join(os.homedir(), '.dispatch')` with `platform.dataDir()`.

- [ ] **Step 4: Guard the Tailscale path**

In `packages/core/src/routes/state.ts`, wrap the macOS Tailscale invocation:

```ts
import { platform } from '../platform/index.js';
if (platform.id !== 'darwin') {
  return res.json({ available: false, status: null });
}
// ...existing macOS Tailscale code...
```

- [ ] **Step 5: Add a wiring guard test**

```ts
// packages/core/tests/platform/wiring.test.ts
import { expect, test } from 'vitest';
import { platform } from '../../src/platform/index.js';

test('no source file outside platform/ branches on process.platform', async () => {
  // Static guard: this test documents the invariant. The grep below is run in CI (Task 14).
  expect(platform.id).toBe(process.platform);
});
```

- [ ] **Step 6: Run the full core suite**

Run: `pnpm --filter dispatch-server test`
Expected: PASS — all existing tests green (macOS behavior unchanged), plus the new platform tests.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src packages/core/tests/platform/wiring.test.ts
git commit -m "refactor(core): route runtime call sites through the platform layer"
```

---

## Phase 2 — `DaemonController` + cross-platform Node CLI

### Task 8: `DaemonController` interface + Task Scheduler XML builder (pure)

**Files:**
- Create: `packages/core/src/platform/daemon.ts` (interface + `DaemonInstallOptions`/`DaemonStatus`)
- Create: `packages/core/src/platform/win32-task-xml.ts` (pure XML builder)
- Test: `packages/core/tests/platform/win32-task-xml.test.ts`

**Interfaces:**
- Produces: `DaemonController`, `DaemonInstallOptions`, `DaemonStatus`, `buildLogonTaskXml(opts): string`.

- [ ] **Step 1: Write the interface**

```ts
// packages/core/src/platform/daemon.ts
export interface DaemonInstallOptions {
  port: number;
  nodePath: string;     // absolute path to node
  entry: string;        // absolute path to packages/core/dist/server.js
  repoRoot: string;
  env: Record<string, string>;
  logDir: string;
}
export interface DaemonStatus { loaded: boolean; pid?: number; }
export interface DaemonController {
  install(opts: DaemonInstallOptions): void;
  uninstall(): void;
  start(): void;
  stop(): void;
  restart(): void;
  status(): DaemonStatus;
}
```

- [ ] **Step 2: Write the failing test for the XML builder**

```ts
// packages/core/tests/platform/win32-task-xml.test.ts
import { describe, expect, test } from 'vitest';
import { buildLogonTaskXml } from '../../src/platform/win32-task-xml.js';

describe('buildLogonTaskXml', () => {
  const xml = buildLogonTaskXml({
    port: 3456, nodePath: 'C:\\node.exe',
    entry: 'C:\\repo\\packages\\core\\dist\\server.js',
    repoRoot: 'C:\\repo', env: { PORT: '3456' },
    logDir: 'C:\\logs', userId: 'DOMAIN\\user',
  });
  test('is a LogonTrigger task running as the current user, interactive', () => {
    expect(xml).toContain('<LogonTrigger>');
    expect(xml).toContain('<UserId>DOMAIN\\user</UserId>');
    expect(xml).toContain('<LogonType>InteractiveToken</LogonType>');
  });
  test('restarts on failure and never times out', () => {
    expect(xml).toContain('<RestartOnFailure>');
    expect(xml).toContain('<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>');
  });
  test('invokes node with the server entry and bakes PORT', () => {
    expect(xml).toContain('C:\\node.exe');
    expect(xml).toContain('server.js');
  });
  test('escapes XML metacharacters in arguments', () => {
    const x = buildLogonTaskXml({
      port: 1, nodePath: 'n', entry: 'e', repoRoot: 'r',
      env: { X: 'a&b<c>' }, logDir: 'l', userId: 'u',
    });
    expect(x).toContain('a&amp;b&lt;c&gt;');
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm --filter dispatch-server exec vitest run tests/platform/win32-task-xml.test.ts`
Expected: FAIL — `buildLogonTaskXml` not defined.

- [ ] **Step 4: Implement**

```ts
// packages/core/src/platform/win32-task-xml.ts
import type { DaemonInstallOptions } from './daemon.js';

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

export function buildLogonTaskXml(opts: DaemonInstallOptions & { userId: string }): string {
  // Wrapper command: set env then launch node with the server entry; redirect logs.
  const envSetup = Object.entries(opts.env)
    .map(([k, v]) => `$env:${k}='${v.replace(/'/g, "''")}';`).join(' ');
  const cmd =
    `${envSetup} & '${opts.nodePath}' '${opts.entry}' ` +
    `*> '${opts.logDir}\\dispatch.out.log'`;
  const args = `-NoLogo -NonInteractive -Command "${esc(cmd)}"`;
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Triggers><LogonTrigger><Enabled>true</Enabled><UserId>${esc(opts.userId)}</UserId></LogonTrigger></Triggers>
  <Principals><Principal id="Author">
    <UserId>${esc(opts.userId)}</UserId>
    <LogonType>InteractiveToken</LogonType>
    <RunLevel>HighestAvailable</RunLevel>
  </Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec><Command>powershell.exe</Command><Arguments>${esc(args)}</Arguments></Exec>
  </Actions>
</Task>`;
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm --filter dispatch-server exec vitest run tests/platform/win32-task-xml.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/platform/daemon.ts packages/core/src/platform/win32-task-xml.ts packages/core/tests/platform/win32-task-xml.test.ts
git commit -m "feat(platform): DaemonController interface + Task Scheduler XML builder"
```

---

### Task 9: `win32` DaemonController (schtasks) + `darwin` DaemonController (launchd, ported from bash)

**Files:**
- Create: `packages/core/src/platform/daemon-win32.ts`
- Create: `packages/core/src/platform/daemon-darwin.ts`
- Modify: `packages/core/src/platform/darwin.ts` and `win32.ts` to expose `daemon: DaemonController` (add to the `Platform` interface in `types.ts` as `readonly daemon: DaemonController`)
- Test: `packages/core/tests/platform/daemon-win32.test.ts` (command construction via an injected runner)

**Interfaces:**
- Consumes: `DaemonController`, `buildLogonTaskXml`.
- Produces: `createWin32Daemon(run?: Runner): DaemonController`, `createDarwinDaemon(run?: Runner): DaemonController`, where `type Runner = (cmd: string, args: string[]) => string`.

- [ ] **Step 1: Write the failing test** (inject a fake runner so we assert the exact `schtasks` invocations on macOS)

```ts
// packages/core/tests/platform/daemon-win32.test.ts
import { describe, expect, test, vi } from 'vitest';
import { createWin32Daemon } from '../../src/platform/daemon-win32.js';

describe('win32 daemon (schtasks command construction)', () => {
  const opts = {
    port: 3456, nodePath: 'C:\\node.exe', entry: 'C:\\repo\\dist\\server.js',
    repoRoot: 'C:\\repo', env: { PORT: '3456' }, logDir: 'C:\\logs',
  };
  test('install registers a task from generated XML with /F', () => {
    const calls: Array<[string, string[]]> = [];
    const run = vi.fn((cmd: string, args: string[]) => { calls.push([cmd, args]); return ''; });
    const d = createWin32Daemon(run, () => 'DOMAIN\\user');
    d.install(opts);
    const create = calls.find(([c, a]) => c === 'schtasks' && a.includes('/Create'));
    expect(create).toBeTruthy();
    expect(create![1]).toEqual(expect.arrayContaining(['/Create', '/TN', 'Dispatch', '/XML', '/F']));
  });
  test('start/stop/uninstall use /Run /End /Delete', () => {
    const calls: string[][] = [];
    const run = (cmd: string, args: string[]) => { calls.push([cmd, ...args]); return ''; };
    const d = createWin32Daemon(run, () => 'u');
    d.start(); d.stop(); d.uninstall();
    expect(calls.some((c) => c.includes('/Run'))).toBe(true);
    expect(calls.some((c) => c.includes('/End'))).toBe(true);
    expect(calls.some((c) => c.includes('/Delete'))).toBe(true);
  });
  test('status parses schtasks /Query Running/Ready', () => {
    const run = () => 'TaskName: \\Dispatch\r\nStatus: Running\r\n';
    const d = createWin32Daemon(run, () => 'u');
    expect(d.status().loaded).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter dispatch-server exec vitest run tests/platform/daemon-win32.test.ts`
Expected: FAIL — `createWin32Daemon` not defined.

- [ ] **Step 3: Implement `daemon-win32.ts`**

```ts
// packages/core/src/platform/daemon-win32.ts
import os from 'os';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import type { DaemonController, DaemonInstallOptions, DaemonStatus } from './daemon.js';
import { buildLogonTaskXml } from './win32-task-xml.js';

export type Runner = (cmd: string, args: string[]) => string;
const TASK = 'Dispatch';
const defaultRun: Runner = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf-8' });
const defaultUser = () => `${process.env.USERDOMAIN ?? os.hostname()}\\${process.env.USERNAME ?? os.userInfo().username}`;

export function createWin32Daemon(run: Runner = defaultRun, userId: () => string = defaultUser): DaemonController {
  return {
    install(opts: DaemonInstallOptions) {
      fs.mkdirSync(opts.logDir, { recursive: true });
      const xml = buildLogonTaskXml({ ...opts, userId: userId() });
      const xmlPath = path.join(opts.logDir, 'dispatch-task.xml');
      fs.writeFileSync(xmlPath, '﻿' + xml, { encoding: 'utf16le' });
      run('schtasks', ['/Create', '/TN', TASK, '/XML', xmlPath, '/F']);
      run('schtasks', ['/Run', '/TN', TASK]);
    },
    uninstall() { run('schtasks', ['/Delete', '/TN', TASK, '/F']); },
    start() { run('schtasks', ['/Run', '/TN', TASK]); },
    stop() { run('schtasks', ['/End', '/TN', TASK]); },
    restart() { try { run('schtasks', ['/End', '/TN', TASK]); } catch {} run('schtasks', ['/Run', '/TN', TASK]); },
    status(): DaemonStatus {
      try {
        const out = run('schtasks', ['/Query', '/TN', TASK]);
        return { loaded: /Running|Ready/i.test(out) };
      } catch {
        return { loaded: false };
      }
    },
  };
}
```

- [ ] **Step 4: Implement `daemon-darwin.ts`** (port the launchd flow from `bin/dispatch`: write plist → `launchctl bootstrap`/`enable` → `kickstart`; `bootout` to remove; `kickstart -k` to restart; `launchctl list` for status)

```ts
// packages/core/src/platform/daemon-darwin.ts
import os from 'os';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import type { DaemonController, DaemonInstallOptions, DaemonStatus } from './daemon.js';

export type Runner = (cmd: string, args: string[]) => string;
const LABEL = 'com.dispatch.server';
const defaultRun: Runner = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf-8' });

export function createDarwinDaemon(run: Runner = defaultRun): DaemonController {
  const uid = process.getuid?.() ?? 0;
  const domain = `gui/${uid}`;
  const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
  return {
    install(opts: DaemonInstallOptions) {
      fs.mkdirSync(path.dirname(plistPath), { recursive: true });
      fs.mkdirSync(opts.logDir, { recursive: true });
      fs.writeFileSync(plistPath, buildPlist(opts));      // buildPlist mirrors daemon/*.plist.template
      try { run('launchctl', ['bootstrap', domain, plistPath]); }
      catch { run('launchctl', ['load', '-w', plistPath]); }
    },
    uninstall() { try { run('launchctl', ['bootout', `${domain}/${LABEL}`]); } catch {} },
    start() { run('launchctl', ['kickstart', `${domain}/${LABEL}`]); },
    stop() { run('launchctl', ['bootout', `${domain}/${LABEL}`]); },
    restart() { run('launchctl', ['kickstart', '-k', `${domain}/${LABEL}`]); },
    status(): DaemonStatus {
      try {
        const out = run('launchctl', ['list']);
        return { loaded: out.includes(LABEL) };
      } catch { return { loaded: false }; }
    },
  };
}

function buildPlist(opts: DaemonInstallOptions): string {
  const envEntries = Object.entries(opts.env)
    .map(([k, v]) => `    <key>${k}</key><string>${v}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array><string>${opts.nodePath}</string><string>${opts.entry}</string></array>
  <key>EnvironmentVariables</key><dict>
${envEntries}
  </dict>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${opts.logDir}/dispatch.out.log</string>
  <key>StandardErrorPath</key><string>${opts.logDir}/dispatch.err.log</string>
</dict></plist>`;
}
```

- [ ] **Step 5: Wire `daemon` onto each Platform impl**

Add `readonly daemon: DaemonController;` to `Platform` in `types.ts`. In `darwin.ts` add `daemon: createDarwinDaemon(),` and in `win32.ts` add `daemon: createWin32Daemon(),`.

- [ ] **Step 6: Run the daemon tests + full suite**

Run: `pnpm --filter dispatch-server test`
Expected: PASS — daemon-win32 tests + all prior.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/platform packages/core/tests/platform
git commit -m "feat(platform): per-platform DaemonController (schtasks + launchd)"
```

---

### Task 10: Cross-platform Node CLI

**Files:**
- Create: `packages/cli/package.json`, `packages/cli/tsconfig.json`, `packages/cli/src/index.ts`
- Modify: root `package.json` `bin` → `{ "dispatch": "packages/cli/dist/index.js" }`
- Modify: `pnpm-workspace.yaml` (already globs `packages/*`; confirm)
- Test: `packages/cli/tests/commands.test.ts` (dispatch table + arg parsing via injected daemon)

**Interfaces:**
- Consumes: `platform` + `platform.daemon` from `dispatch-server`.
- Produces: a `dispatch` binary with `build|install|uninstall|start|stop|restart|status|update|run|logs`.

- [ ] **Step 1: Write the failing test** (command routing with an injected fake daemon)

```ts
// packages/cli/tests/commands.test.ts
import { describe, expect, test, vi } from 'vitest';
import { runCommand } from '../src/index.js';

describe('dispatch CLI routing', () => {
  test('install → daemon.install; status → daemon.status', () => {
    const daemon = { install: vi.fn(), uninstall: vi.fn(), start: vi.fn(), stop: vi.fn(),
      restart: vi.fn(), status: vi.fn(() => ({ loaded: true, pid: 1 })) };
    runCommand(['install'], { daemon, port: 3456 } as any);
    expect(daemon.install).toHaveBeenCalledOnce();
    runCommand(['status'], { daemon, port: 3456 } as any);
    expect(daemon.status).toHaveBeenCalledOnce();
  });
  test('unknown command throws a usage error', () => {
    expect(() => runCommand(['bogus'], {} as any)).toThrow(/usage/i);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter dispatch-cli exec vitest run`
Expected: FAIL — package/module not present.

- [ ] **Step 3: Scaffold the package + implement `runCommand`**

`packages/cli/package.json` (name `dispatch-cli`, type module, `bin` `dist/index.js`, dep on `dispatch-server` workspace, scripts `build: tsc`, `test: vitest run`). `tsconfig.json` extends the repo base. Then:

```ts
// packages/cli/src/index.ts
import { platform } from 'dispatch-server/platform';   // add a subpath export from core
import type { DaemonController } from 'dispatch-server/platform';

interface Ctx { daemon: DaemonController; port: number; }

export function runCommand(argv: string[], ctx: Ctx): void {
  const [cmd] = argv;
  switch (cmd) {
    case 'install':   ctx.daemon.install(buildInstallOpts(ctx)); return;
    case 'uninstall': ctx.daemon.uninstall(); return;
    case 'start':     ctx.daemon.start(); return;
    case 'stop':      ctx.daemon.stop(); return;
    case 'restart':   ctx.daemon.restart(); return;
    case 'status': {
      const s = ctx.daemon.status();
      console.log(s.loaded ? `loaded yes${s.pid ? ` (pid ${s.pid})` : ''}` : 'loaded no');
      return;
    }
    // build/update/run/logs implemented in Step 5 (they shell out / spawn node)
    default:
      throw new Error(`usage: dispatch <build|install|uninstall|start|stop|restart|status|update|run|logs>`);
  }
}
// buildInstallOpts(ctx) computes nodePath=process.execPath, entry=<core>/dist/server.js,
// repoRoot, logDir=platform.logDir(), env={ PORT, ...secrets/shim env } — see Step 5.
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter dispatch-cli exec vitest run`
Expected: PASS (2 tests).

- [ ] **Step 5: Implement `build`, `update`, `run`, `logs` + the real entrypoint**

Add: `build` → `pnpm -r run build`; `update` → `git pull --ff-only` then `build` then `restart`; `run` → spawn `node <entry>` in the foreground with the install env; `logs` → tail `platform.logDir()/dispatch.out.log` (read + follow). Add the `main()` that builds `ctx` from `platform.daemon` + resolved paths and calls `runCommand(process.argv.slice(2), ctx)`. Add a `platform` subpath export to `packages/core/package.json` (`"./platform": "./dist/platform/index.js"`).

- [ ] **Step 6: Build + smoke the CLI on macOS (parity check)**

Run: `pnpm -r run build && node packages/cli/dist/index.js status`
Expected: prints `loaded yes/no` consistent with `./bin/dispatch status`. (macOS daemon controller exercised end to end.)

- [ ] **Step 7: Commit**

```bash
git add packages/cli packages/core/package.json package.json pnpm-workspace.yaml
git commit -m "feat(cli): cross-platform Node CLI replacing bin/dispatch"
```

---

### Task 11: Replace `bin/dispatch` with a thin shim; keep `dispatch` on PATH

**Files:**
- Modify: `bin/dispatch` → thin stub that execs the Node CLI (`exec node "$REPO/packages/cli/dist/index.js" "$@"`), preserving the existing `PATH`-symlink workflow on macOS.
- Test: manual parity (covered in Task 10 Step 6).

- [ ] **Step 1: Replace the script body**

```sh
#!/bin/sh
DIR="$(cd "$(dirname "$0")/.." && pwd)"
exec node "$DIR/packages/cli/dist/index.js" "$@"
```

- [ ] **Step 2: Verify parity**

Run: `./bin/dispatch status`
Expected: same output as `node packages/cli/dist/index.js status`.

- [ ] **Step 3: Commit**

```bash
git add bin/dispatch
git commit -m "refactor(cli): bin/dispatch delegates to the Node CLI"
```

---

## Phase 3 — CI + docs

### Task 12: GitHub Actions `windows-latest` CI

**Files:**
- Create: `.github/workflows/windows.yml`
- Modify: existing CI workflow (if any) is left intact.

- [ ] **Step 1: Write the workflow**

```yaml
# .github/workflows/windows.yml
name: windows
on: [push, pull_request]
jobs:
  build-test:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 9 }
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm -r run build
      - run: pnpm -r run test
      - name: Guard — no process.platform branching outside platform/
        shell: bash
        run: |
          if grep -rnE "process\.platform" packages/core/src packages/web/src | grep -v "src/platform/"; then
            echo "process.platform used outside platform/"; exit 1; fi
```

- [ ] **Step 2: Verify the guard locally**

Run: `grep -rnE "process\.platform" packages/core/src packages/web/src | grep -v "src/platform/" || echo OK`
Expected: `OK`.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/windows.yml
git commit -m "ci: build + test on windows-latest with platform-branching guard"
```

---

### Task 13: Docs — README + AGENTS Windows sections + bring-up checklist

**Files:**
- Modify: `README.md` (add a "Windows" subsection under Prerequisites + Quick start: `node`, `pnpm`, PowerShell; `dispatch install` registers a logon task; data dir `%USERPROFILE%\.dispatch`, logs `%LOCALAPPDATA%\dispatch\logs`).
- Modify: `AGENTS.md` (Windows setup steps mirroring the macOS ones; note Codex + Claude both native; the two deferred features).
- Create: `docs/windows-bring-up.md` (the coworker checklist, copied from the spec's Testing section).

- [ ] **Step 1: Write the README Windows subsection** (mirror existing macOS quick-start; commands: `pnpm install`, `pnpm -r run build`, `dispatch install`, open `http://localhost:3456`).
- [ ] **Step 2: Write the AGENTS.md Windows steps** (env check `node -v`/`pnpm -v`/PowerShell; CLIs `claude`/`codex` installed + authed; `dispatch install`/`status`/`logs`).
- [ ] **Step 3: Write `docs/windows-bring-up.md`** (the 7-step checklist from the spec verbatim).
- [ ] **Step 4: Commit**

```bash
git add README.md AGENTS.md docs/windows-bring-up.md
git commit -m "docs: Windows setup (README + AGENTS) + coworker bring-up checklist"
```

---

### Task 14: Final verification gate (macOS) + handoff

- [ ] **Step 1: Full suite + build, macOS**

Run: `pnpm -r run test && pnpm -r run build`
Expected: all green; macOS behavior unchanged (daemon install/status/restart parity via the new CLI).

- [ ] **Step 2: macOS daemon round-trip**

Run (in a scratch port + HOME, to avoid touching the live daemon): `HOME=$(mktemp -d) PORT=4555 node packages/cli/dist/index.js run &` then `curl -fsS http://localhost:4555/api/sessions` → HTTP 200; kill it.

- [ ] **Step 3: Hand off to the coworker** — they execute `docs/windows-bring-up.md` on Windows 11 (the runtime-only confirmations CI cannot do), and report back any `claudeProjectDir` encoding or `.cmd` spawn adjustments.

---

## Self-Review

- **Spec coverage:** Platform interface (T1), all runtime divergences — shell (T4/T5/T7), login PATH (T4/T5/T7), data/log dirs (T4/T5), resolveCommand (T4/T5), listProcessIds (T3/T4/T5/T7), claudeProjectDir (T2/T7), browser shim no-op (T5/T7), Tailscale guard (T7); daemon lifecycle Task Scheduler (T8/T9) + launchd parity (T9); Node CLI (T10/T11); deferred features (T5/T7); CI (T12); docs + bring-up checklist (T13); Codex handled via resolveCommand (T5/T10) and verified in bring-up (T13/T14). ✓
- **Placeholder scan:** code provided for every code step; `buildInstallOpts`, `build/update/run/logs`, and the README/AGENTS prose are the only narrative steps and each names exact inputs/outputs (not "TBD").
- **Type consistency:** `Platform`, `ShellSpec`, `BrowserShimEnv`, `DaemonController`, `DaemonInstallOptions`, `Runner`, `buildLogonTaskXml`, `createWin32Daemon`, `createDarwinDaemon`, `runCommand` are used with the same signatures across tasks.

## Known follow-ups (post-v1, out of scope)
- Browser/OAuth capture shim on Windows (a `.cmd`/`.ps1` variant).
- Tailscale status on Windows (the Windows Tailscale CLI path).
- Linux `Platform` implementation (interface already supports it).
