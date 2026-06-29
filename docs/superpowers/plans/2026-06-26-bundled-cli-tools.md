# Bundled CLI Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a curated, extendable set of CLIs that the agent can call in any Dispatch thread (no per-machine install), authenticated via Doppler env, with an awareness note injected per provider and a read-only Settings view.

**Architecture:** A self-contained `packages/core/src/tools/` subsystem owns a managed prefix `~/.dispatch/tools/` (its `bin/` is prepended to every thread's PATH). A manifest (shipped default bundle merged with `~/.dispatch/tools.json`) drives an installer (`dispatch tools install`, kinds `binary`/`npm`/`script`). At thread spawn the tools PATH + `envAlias` ride the existing `setDefaultEnv` channel, and an awareness note is folded into `composeInjection` (Claude `--append-system-prompt`, Codex `-c developer_instructions`). A read-only `GET /api/tools` powers a Settings "Tools" view.

**Tech Stack:** TypeScript (Node ESM, `.js` import specifiers), better-sqlite3 (unused here — tools are file-based), Express, vitest + supertest (core), React + vitest + @testing-library/react (web), bash (`bin/dispatch`).

## Global Constraints

- **ESM `.js` import specifiers** in all core imports (e.g. `import { loadManifest } from './manifest.js'`).
- **Managed prefix is `~/.dispatch/tools/`** — canonical base `path.join(os.homedir(), '.dispatch', 'tools')`; every path function takes an optional `base` override for tests.
- **macOS only** (platform keys `darwin-arm64` / `darwin-x64`); other platforms are out of scope.
- **`sha256` is optional per manifest entry** — verified only if present.
- **Codex value encoding:** `-c developer_instructions=${JSON.stringify(note)}` — `JSON.stringify` output is a valid TOML basic string, matching the existing `-c mcp_servers…` pattern in `mcp/injection.ts`.
- **Awareness note reaches both providers** via `composeInjection`'s new `developerNote` option; the existing MCP `prompts`→Claude-systemPrompt behavior is unchanged.
- **`configFile` (file-based auth) is OUT of v1** — the chosen default set + the user's stack all authenticate via env vars; `envAlias` (secret-name remapping) covers the "per-CLI config" need without writing secrets to disk. (Noted as a follow-up in the spec.)
- **Default bundle:** `jq`, `ripgrep`, `gh`, `doppler`, `databricks` (`binary`), `@shopify/cli` (`npm`), `aws` (`script`).
- **Security:** the agent runs with `--dangerously-skip-permissions`, so every bundled CLI is freely invokable; this is accepted. Never log secret values.

---

### Task 1: Tool paths + types

**Files:**
- Create: `packages/core/src/tools/paths.ts`
- Create: `packages/core/src/tools/types.ts`
- Test: `packages/core/tests/tools/paths.test.ts`

**Interfaces:**
- Produces:
  - `interface ToolEntry { name: string; description: string; kind: 'binary'|'npm'|'script'; binary?: Record<string, { url: string; sha256?: string; archive?: 'tar.gz'|'zip'|'none'; binPath?: string }>; npm?: { package: string; version?: string }; script?: { install: string }; bins: string[]; authEnv?: string[]; envAlias?: Record<string,string>; docs?: string }`
  - `interface ToolStatus { name: string; description: string; kind: ToolEntry['kind']; installed: boolean; version?: string; authed: boolean; docs?: string }`
  - `interface ToolPaths { dir: string; bin: string; cache: string; pkgs: string; installed: string; userManifest: string }`
  - `function toolPaths(base?: string): ToolPaths`
  - `function hostPlatformKey(): string` → `darwin-arm64` | `darwin-x64`

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/tests/tools/paths.test.ts
import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { toolPaths, hostPlatformKey } from '../../src/tools/paths.js';

describe('tool paths', () => {
  it('defaults under ~/.dispatch/tools', () => {
    const p = toolPaths();
    expect(p.dir).toBe(path.join(os.homedir(), '.dispatch', 'tools'));
    expect(p.bin).toBe(path.join(p.dir, 'bin'));
    expect(p.installed).toBe(path.join(p.dir, 'installed.json'));
    expect(p.userManifest).toBe(path.join(os.homedir(), '.dispatch', 'tools.json'));
  });
  it('honors a base override (for tests)', () => {
    const p = toolPaths('/tmp/x');
    expect(p.dir).toBe('/tmp/x');
    expect(p.bin).toBe('/tmp/x/bin');
  });
  it('hostPlatformKey is a darwin key on this platform', () => {
    expect(['darwin-arm64', 'darwin-x64']).toContain(hostPlatformKey());
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/davidwebber/Sites/dispatch && pnpm --filter dispatch-server exec vitest run tests/tools/paths.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `types.ts`**

```ts
// packages/core/src/tools/types.ts
export interface ToolBinaryAsset { url: string; sha256?: string; archive?: 'tar.gz' | 'zip' | 'none'; binPath?: string; }
export interface ToolEntry {
  name: string;
  description: string;
  kind: 'binary' | 'npm' | 'script';
  binary?: Record<string, ToolBinaryAsset>; // platform key -> asset
  npm?: { package: string; version?: string };
  script?: { install: string };
  bins: string[];
  authEnv?: string[];
  envAlias?: Record<string, string>; // CLI-expected var -> source env var name
  docs?: string;
}
export interface ToolStatus {
  name: string;
  description: string;
  kind: ToolEntry['kind'];
  installed: boolean;
  version?: string;
  authed: boolean;
  docs?: string;
}
```

- [ ] **Step 4: Implement `paths.ts`**

```ts
// packages/core/src/tools/paths.ts
import os from 'node:os';
import path from 'node:path';

export interface ToolPaths { dir: string; bin: string; cache: string; pkgs: string; installed: string; userManifest: string; }

export function toolPaths(base?: string): ToolPaths {
  const dir = base ?? path.join(os.homedir(), '.dispatch', 'tools');
  return {
    dir,
    bin: path.join(dir, 'bin'),
    cache: path.join(dir, 'cache'),
    pkgs: path.join(dir, 'pkgs'),
    installed: path.join(dir, 'installed.json'),
    userManifest: path.join(path.dirname(dir), 'tools.json'),
  };
}

export function hostPlatformKey(): string {
  return process.arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64';
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd /Users/davidwebber/Sites/dispatch && pnpm --filter dispatch-server exec vitest run tests/tools/paths.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
cd /Users/davidwebber/Sites/dispatch
git add packages/core/src/tools/paths.ts packages/core/src/tools/types.ts packages/core/tests/tools/paths.test.ts
git commit -m "feat(tools): tool paths + types"
```

---

### Task 2: Manifest (default bundle + user merge + validation)

**Files:**
- Create: `packages/core/src/tools/default-tools.json`
- Create: `packages/core/src/tools/manifest.ts`
- Test: `packages/core/tests/tools/manifest.test.ts`

**Interfaces:**
- Consumes: `ToolEntry` (Task 1), `toolPaths` (Task 1).
- Produces: `function loadManifest(base?: string): ToolEntry[]` (default bundle merged with the user file; user entries override/extend by `name`; invalid entries dropped). `function validateEntry(e: unknown): e is ToolEntry`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/tests/tools/manifest.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadManifest, validateEntry } from '../../src/tools/manifest.js';

let base: string;
beforeEach(() => { base = fs.mkdtempSync(path.join(os.tmpdir(), 'tools-')); });
afterEach(() => { fs.rmSync(base, { recursive: true, force: true }); });

describe('manifest', () => {
  it('returns the default bundle when no user file', () => {
    const m = loadManifest(base);
    const names = m.map((e) => e.name);
    expect(names).toContain('jq');
    expect(names).toContain('gh');
    expect(names).toContain('aws');
  });

  it('merges user entries and overrides by name', () => {
    fs.writeFileSync(path.join(path.dirname(base), 'tools.json'), JSON.stringify({
      tools: [
        { name: 'mytool', description: 'mine', kind: 'binary', bins: ['mytool'], binary: { 'darwin-arm64': { url: 'https://x/mytool', archive: 'none' } } },
        { name: 'jq', description: 'overridden jq', kind: 'binary', bins: ['jq'], binary: { 'darwin-arm64': { url: 'https://x/jq', archive: 'none' } } },
      ],
    }));
    const m = loadManifest(base);
    expect(m.find((e) => e.name === 'mytool')).toBeTruthy();
    expect(m.find((e) => e.name === 'jq')!.description).toBe('overridden jq');
  });

  it('drops invalid user entries', () => {
    fs.writeFileSync(path.join(path.dirname(base), 'tools.json'), JSON.stringify({
      tools: [{ name: 'bad' /* missing kind/bins */ }, 'nope'],
    }));
    const m = loadManifest(base);
    expect(m.find((e) => e.name === 'bad')).toBeFalsy();
  });

  it('validateEntry accepts a minimal binary entry and rejects junk', () => {
    expect(validateEntry({ name: 'x', description: 'd', kind: 'binary', bins: ['x'] })).toBe(true);
    expect(validateEntry({ name: 'x' })).toBe(false);
    expect(validateEntry(null)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/davidwebber/Sites/dispatch && pnpm --filter dispatch-server exec vitest run tests/tools/manifest.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `default-tools.json` (worked entries + the rest by pattern)**

Author the default bundle. `jq` (binary, `none`) and `@shopify/cli` (npm) are fully worked below; add `ripgrep`, `gh`, `doppler`, `databricks`, `aws` following the same shapes. **Pin current versions** and (optionally) checksums — fetch each release URL from the project's GitHub releases (or npm for shopify), and for any entry where you want verification add `sha256` via `curl -sL <url> | shasum -a 256`. Omit `sha256` to skip verification (allowed). Use platform keys `darwin-arm64`/`darwin-x64`. For `gh` the archive is a `zip` whose binary is at `binPath: "bin/gh"`; for `ripgrep`/`doppler`/`databricks` the archive is `tar.gz` with `binPath` the binary inside; `jq` ships a raw binary (`archive: "none"`); `aws` uses the `script` kind (the awscli zip + `./aws/install` targeting the prefix).

```jsonc
{
  "tools": [
    {
      "name": "jq",
      "description": "Command-line JSON processor",
      "kind": "binary",
      "bins": ["jq"],
      "binary": {
        "darwin-arm64": { "url": "https://github.com/jqlang/jq/releases/download/jq-1.7.1/jq-macos-arm64", "archive": "none" },
        "darwin-x64":   { "url": "https://github.com/jqlang/jq/releases/download/jq-1.7.1/jq-macos-amd64", "archive": "none" }
      },
      "docs": "https://jqlang.github.io/jq/"
    },
    {
      "name": "ripgrep",
      "description": "Fast recursive search (rg)",
      "kind": "binary",
      "bins": ["rg"],
      "binary": {
        "darwin-arm64": { "url": "https://github.com/BurntSushi/ripgrep/releases/download/14.1.1/ripgrep-14.1.1-aarch64-apple-darwin.tar.gz", "archive": "tar.gz", "binPath": "ripgrep-14.1.1-aarch64-apple-darwin/rg" },
        "darwin-x64":   { "url": "https://github.com/BurntSushi/ripgrep/releases/download/14.1.1/ripgrep-14.1.1-x86_64-apple-darwin.tar.gz", "archive": "tar.gz", "binPath": "ripgrep-14.1.1-x86_64-apple-darwin/rg" }
      },
      "docs": "https://github.com/BurntSushi/ripgrep"
    },
    {
      "name": "gh",
      "description": "GitHub CLI",
      "kind": "binary",
      "bins": ["gh"],
      "authEnv": ["GH_TOKEN"],
      "envAlias": { "GH_TOKEN": "GITHUB_TOKEN" },
      "binary": {
        "darwin-arm64": { "url": "https://github.com/cli/cli/releases/download/v2.62.0/gh_2.62.0_macOS_arm64.zip", "archive": "zip", "binPath": "gh_2.62.0_macOS_arm64/bin/gh" },
        "darwin-x64":   { "url": "https://github.com/cli/cli/releases/download/v2.62.0/gh_2.62.0_macOS_amd64.zip", "archive": "zip", "binPath": "gh_2.62.0_macOS_amd64/bin/gh" }
      },
      "docs": "https://cli.github.com/"
    },
    {
      "name": "doppler",
      "description": "Doppler secrets CLI",
      "kind": "binary",
      "bins": ["doppler"],
      "authEnv": ["DOPPLER_TOKEN"],
      "binary": {
        "darwin-arm64": { "url": "https://github.com/DopplerHQ/cli/releases/download/3.69.0/doppler_3.69.0_macOS_arm64.tar.gz", "archive": "tar.gz", "binPath": "doppler" },
        "darwin-x64":   { "url": "https://github.com/DopplerHQ/cli/releases/download/3.69.0/doppler_3.69.0_macOS_amd64.tar.gz", "archive": "tar.gz", "binPath": "doppler" }
      },
      "docs": "https://docs.doppler.com/docs/cli"
    },
    {
      "name": "databricks",
      "description": "Databricks CLI",
      "kind": "binary",
      "bins": ["databricks"],
      "authEnv": ["DATABRICKS_HOST", "DATABRICKS_TOKEN"],
      "binary": {
        "darwin-arm64": { "url": "https://github.com/databricks/cli/releases/download/v0.231.0/databricks_cli_0.231.0_darwin_arm64.tar.gz", "archive": "tar.gz", "binPath": "databricks" },
        "darwin-x64":   { "url": "https://github.com/databricks/cli/releases/download/v0.231.0/databricks_cli_0.231.0_darwin_amd64.tar.gz", "archive": "tar.gz", "binPath": "databricks" }
      },
      "docs": "https://docs.databricks.com/dev-tools/cli/"
    },
    {
      "name": "shopify",
      "description": "Shopify CLI",
      "kind": "npm",
      "bins": ["shopify"],
      "npm": { "package": "@shopify/cli", "version": "latest" },
      "docs": "https://shopify.dev/docs/api/shopify-cli"
    },
    {
      "name": "aws",
      "description": "AWS CLI v2",
      "kind": "script",
      "bins": ["aws"],
      "authEnv": ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"],
      "script": {
        "install": "set -e; tmp=$(mktemp -d); curl -fsSL \"https://awscli.amazonaws.com/AWSCLIV2.pkg\" -o \"$tmp/awscli.pkg\"; pkgutil --expand-full \"$tmp/awscli.pkg\" \"$tmp/x\"; PFX=$(find \"$tmp/x\" -type d -name 'aws-cli' | head -1); ln -sf \"$PFX/aws\" \"$TOOLS_BIN/aws\"; ln -sf \"$PFX/aws_completer\" \"$TOOLS_BIN/aws_completer\" 2>/dev/null || true"
      },
      "docs": "https://docs.aws.amazon.com/cli/"
    }
  ]
}
```

Note: verify the `aws` script resolves `aws` into `$TOOLS_BIN` on a real machine during the manual check (Task 9); if `pkgutil --expand-full` layout differs, adjust the `find` path. The script kind is the escape hatch for exactly this kind of non-single-binary installer.

- [ ] **Step 4: Implement `manifest.ts`**

```ts
// packages/core/src/tools/manifest.ts
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { toolPaths } from './paths.js';
import type { ToolEntry } from './types.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export function validateEntry(e: unknown): e is ToolEntry {
  if (!e || typeof e !== 'object') return false;
  const t = e as Record<string, unknown>;
  if (typeof t.name !== 'string' || typeof t.description !== 'string') return false;
  if (t.kind !== 'binary' && t.kind !== 'npm' && t.kind !== 'script') return false;
  if (!Array.isArray(t.bins) || !t.bins.every((b) => typeof b === 'string')) return false;
  return true;
}

function readJson(file: string): any { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }

export function loadManifest(base?: string): ToolEntry[] {
  const p = toolPaths(base);
  const def = readJson(path.join(here, 'default-tools.json'));
  const defaults: unknown[] = Array.isArray(def?.tools) ? def.tools : [];
  const user = readJson(p.userManifest);
  const extras: unknown[] = Array.isArray(user?.tools) ? user.tools : [];
  const byName = new Map<string, ToolEntry>();
  for (const e of defaults) if (validateEntry(e)) byName.set(e.name, e);
  for (const e of extras) if (validateEntry(e)) byName.set(e.name, e); // user overrides/extends
  return [...byName.values()];
}
```

The `default-tools.json` must be copied to `dist/` on build. Confirm the core build copies non-TS assets; if `tsc` alone doesn't copy `.json`, add a copy step. Check `packages/core/package.json` build script — if it's just `tsc`, change to `tsc && cp src/tools/default-tools.json dist/tools/default-tools.json` (create `dist/tools` first via `mkdir -p`). Verify the import path resolves at runtime by running the CLI in Task 8.

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd /Users/davidwebber/Sites/dispatch && pnpm --filter dispatch-server exec vitest run tests/tools/manifest.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
cd /Users/davidwebber/Sites/dispatch
git add packages/core/src/tools/default-tools.json packages/core/src/tools/manifest.ts packages/core/tests/tools/manifest.test.ts packages/core/package.json
git commit -m "feat(tools): manifest (default bundle + user merge + validation)"
```

---

### Task 3: Installer (binary / npm / script + idempotency)

**Files:**
- Create: `packages/core/src/tools/installer.ts`
- Test: `packages/core/tests/tools/installer.test.ts`

**Interfaces:**
- Consumes: `ToolEntry`, `ToolPaths`, `toolPaths`, `hostPlatformKey` (Tasks 1).
- Produces:
  - `type Downloader = (url: string) => Promise<Buffer>`
  - `type Exec = (cmd: string, args: string[], opts?: { env?: Record<string,string>; cwd?: string }) => void`
  - `async function installTool(entry: ToolEntry, opts: { base?: string; download?: Downloader; exec?: Exec }): Promise<void>`
  - `function uninstallTool(name: string, base?: string): void`
  - `function readInstalled(base?: string): Record<string, { version?: string; sha?: string }>`

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/tests/tools/installer.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { installTool, readInstalled } from '../../src/tools/installer.js';
import { toolPaths, hostPlatformKey } from '../../src/tools/paths.js';
import type { ToolEntry } from '../../src/tools/types.js';

let base: string;
beforeEach(() => { base = fs.mkdtempSync(path.join(os.tmpdir(), 'tools-i-')); });
afterEach(() => { fs.rmSync(base, { recursive: true, force: true }); });

const plat = hostPlatformKey();

it('binary (archive:none): downloads, verifies sha256, places + chmods, idempotent', async () => {
  const payload = Buffer.from('#!/bin/sh\necho hi\n');
  const sha = crypto.createHash('sha256').update(payload).digest('hex');
  const entry: ToolEntry = { name: 'demo', description: 'd', kind: 'binary', bins: ['demo'], binary: { [plat]: { url: 'https://x/demo', sha256: sha, archive: 'none' } } };
  let calls = 0;
  const download = async () => { calls++; return payload; };
  await installTool(entry, { base, download });
  const binFile = path.join(toolPaths(base).bin, 'demo');
  expect(fs.existsSync(binFile)).toBe(true);
  expect(fs.statSync(binFile).mode & 0o111).toBeTruthy(); // executable
  expect(readInstalled(base).demo).toBeTruthy();
  await installTool(entry, { base, download }); // idempotent: no re-download
  expect(calls).toBe(1);
});

it('binary: sha256 mismatch aborts and installs nothing', async () => {
  const entry: ToolEntry = { name: 'demo', description: 'd', kind: 'binary', bins: ['demo'], binary: { [plat]: { url: 'https://x/demo', sha256: 'deadbeef', archive: 'none' } } };
  await expect(installTool(entry, { base, download: async () => Buffer.from('x') })).rejects.toThrow();
  expect(fs.existsSync(path.join(toolPaths(base).bin, 'demo'))).toBe(false);
});

it('binary (tar.gz): extracts binPath into bin/', async () => {
  // build a real tar.gz fixture with the system tar
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'stg-'));
  fs.mkdirSync(path.join(stage, 'pkg'));
  fs.writeFileSync(path.join(stage, 'pkg', 'rg'), '#!/bin/sh\necho rg\n');
  const tgz = path.join(stage, 'a.tar.gz');
  execFileSync('tar', ['-czf', tgz, '-C', stage, 'pkg']);
  const buf = fs.readFileSync(tgz);
  const entry: ToolEntry = { name: 'ripgrep', description: 'd', kind: 'binary', bins: ['rg'], binary: { [plat]: { url: 'https://x/rg.tgz', archive: 'tar.gz', binPath: 'pkg/rg' } } };
  await installTool(entry, { base, download: async () => buf });
  expect(fs.existsSync(path.join(toolPaths(base).bin, 'rg'))).toBe(true);
  fs.rmSync(stage, { recursive: true, force: true });
});

it('script kind: runs the install script with TOOLS_BIN set', async () => {
  const entry: ToolEntry = { name: 'demo', description: 'd', kind: 'script', bins: ['demo'], script: { install: 'printf "#!/bin/sh\\n" > "$TOOLS_BIN/demo"; chmod +x "$TOOLS_BIN/demo"' } };
  await installTool(entry, { base });
  expect(fs.existsSync(path.join(toolPaths(base).bin, 'demo'))).toBe(true);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/davidwebber/Sites/dispatch && pnpm --filter dispatch-server exec vitest run tests/tools/installer.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `installer.ts`**

```ts
// packages/core/src/tools/installer.ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, execSync } from 'node:child_process';
import { toolPaths, hostPlatformKey, type ToolPaths } from './paths.js';
import type { ToolEntry } from './types.js';

export type Downloader = (url: string) => Promise<Buffer>;
export type Exec = (cmd: string, args: string[], opts?: { env?: Record<string, string>; cwd?: string }) => void;

const defaultDownload: Downloader = async (url) => {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`download ${url} failed: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
};
const defaultExec: Exec = (cmd, args, opts) => { execFileSync(cmd, args, { stdio: 'inherit', env: { ...process.env, ...opts?.env }, cwd: opts?.cwd }); };

export function readInstalled(base?: string): Record<string, { version?: string; sha?: string }> {
  try { return JSON.parse(fs.readFileSync(toolPaths(base).installed, 'utf8')); } catch { return {}; }
}
function writeInstalled(p: ToolPaths, data: Record<string, { version?: string; sha?: string }>): void {
  fs.mkdirSync(p.dir, { recursive: true });
  fs.writeFileSync(p.installed, JSON.stringify(data, null, 2));
}

function ensureDirs(p: ToolPaths): void { for (const d of [p.dir, p.bin, p.cache, p.pkgs]) fs.mkdirSync(d, { recursive: true }); }

export async function installTool(entry: ToolEntry, opts: { base?: string; download?: Downloader; exec?: Exec }): Promise<void> {
  const p = toolPaths(opts.base);
  const download = opts.download ?? defaultDownload;
  const exec = opts.exec ?? defaultExec;
  ensureDirs(p);
  const installed = readInstalled(opts.base);

  if (entry.kind === 'binary') {
    const asset = entry.binary?.[hostPlatformKey()];
    if (!asset) throw new Error(`${entry.name}: no asset for ${hostPlatformKey()}`);
    const key = asset.url + (asset.sha256 ?? '');
    if (installed[entry.name]?.sha === key && fs.existsSync(path.join(p.bin, entry.bins[0]))) return; // idempotent
    const buf = await download(asset.url);
    if (asset.sha256) {
      const got = crypto.createHash('sha256').update(buf).digest('hex');
      if (got !== asset.sha256) throw new Error(`${entry.name}: sha256 mismatch (got ${got})`);
    }
    if ((asset.archive ?? 'none') === 'none') {
      const dest = path.join(p.bin, entry.bins[0]);
      fs.writeFileSync(dest, buf); fs.chmodSync(dest, 0o755);
    } else {
      const work = fs.mkdtempSync(path.join(p.cache, 'x-'));
      const arc = path.join(work, asset.archive === 'zip' ? 'a.zip' : 'a.tgz');
      fs.writeFileSync(arc, buf);
      if (asset.archive === 'zip') exec('unzip', ['-oq', arc, '-d', work]);
      else exec('tar', ['-xzf', arc, '-C', work]);
      const from = path.join(work, asset.binPath ?? entry.bins[0]);
      const dest = path.join(p.bin, entry.bins[0]);
      fs.copyFileSync(from, dest); fs.chmodSync(dest, 0o755);
      fs.rmSync(work, { recursive: true, force: true });
    }
    installed[entry.name] = { sha: key };
    writeInstalled(p, installed);
    return;
  }

  if (entry.kind === 'npm') {
    if (!entry.npm) throw new Error(`${entry.name}: missing npm spec`);
    const spec = `${entry.npm.package}@${entry.npm.version ?? 'latest'}`;
    if (installed[entry.name]?.version === spec && fs.existsSync(path.join(p.bin, entry.bins[0]))) return;
    exec('npm', ['i', '--prefix', p.pkgs, spec]);
    for (const b of entry.bins) {
      const src = path.join(p.pkgs, 'node_modules', '.bin', b);
      const dest = path.join(p.bin, b);
      try { fs.rmSync(dest, { force: true }); } catch { /* ignore */ }
      fs.symlinkSync(src, dest);
    }
    installed[entry.name] = { version: spec };
    writeInstalled(p, installed);
    return;
  }

  // script
  if (!entry.script) throw new Error(`${entry.name}: missing script spec`);
  execSync(entry.script.install, { stdio: 'inherit', env: { ...process.env, TOOLS_PREFIX: p.dir, TOOLS_BIN: p.bin } });
  for (const b of entry.bins) if (!fs.existsSync(path.join(p.bin, b))) throw new Error(`${entry.name}: script did not produce ${b}`);
  installed[entry.name] = {};
  writeInstalled(p, installed);
}

export function uninstallTool(name: string, base?: string): void {
  const p = toolPaths(base);
  const installed = readInstalled(base);
  // best-effort: remove known bins by reading the manifest is the caller's job; here we just drop the record + matching bin name
  const f = path.join(p.bin, name);
  try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
  delete installed[name];
  writeInstalled(p, installed);
}
```

(`os` import is used by callers/tests; keep it only if referenced — remove the unused import if `tsc` flags it.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /Users/davidwebber/Sites/dispatch && pnpm --filter dispatch-server exec vitest run tests/tools/installer.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
cd /Users/davidwebber/Sites/dispatch
git add packages/core/src/tools/installer.ts packages/core/tests/tools/installer.test.ts
git commit -m "feat(tools): installer (binary/npm/script + sha256 + idempotency)"
```

---

### Task 4: Status, spawn-env, awareness note

**Files:**
- Create: `packages/core/src/tools/status.ts`
- Create: `packages/core/src/tools/spawnEnv.ts`
- Create: `packages/core/src/tools/awareness.ts`
- Test: `packages/core/tests/tools/status.test.ts`

**Interfaces:**
- Consumes: `loadManifest` (Task 2), `toolPaths` (Task 1), `ToolStatus`/`ToolEntry` (Task 1).
- Produces:
  - `function toolStatuses(opts?: { base?: string; env?: Record<string, string | undefined> }): ToolStatus[]`
  - `function getToolsSpawnEnv(opts?: { base?: string; env?: Record<string, string | undefined> }): Record<string, string>`
  - `function awarenessNote(statuses: ToolStatus[]): string`

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/tests/tools/status.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { toolStatuses, getToolsSpawnEnv, awarenessNote } from '../../src/tools/status.js';
import { toolPaths } from '../../src/tools/paths.js';

let base: string;
beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'tools-s-'));
  fs.writeFileSync(path.join(path.dirname(base), 'tools.json'), JSON.stringify({ tools: [
    { name: 'gh', description: 'GitHub CLI', kind: 'binary', bins: ['gh'], authEnv: ['GH_TOKEN'], envAlias: { GH_TOKEN: 'GITHUB_TOKEN' }, binary: { 'darwin-arm64': { url: 'https://x/gh', archive: 'none' }, 'darwin-x64': { url: 'https://x/gh', archive: 'none' } } },
  ] }));
});
afterEach(() => { fs.rmSync(base, { recursive: true, force: true }); fs.rmSync(path.join(path.dirname(base), 'tools.json'), { force: true }); });

it('reports installed + authed status', () => {
  // not installed yet
  let st = toolStatuses({ base, env: {} }).find((s) => s.name === 'gh')!;
  expect(st.installed).toBe(false);
  expect(st.authed).toBe(false);
  // install a fake bin + provide auth env
  fs.mkdirSync(toolPaths(base).bin, { recursive: true });
  fs.writeFileSync(path.join(toolPaths(base).bin, 'gh'), '#!/bin/sh\n'); fs.chmodSync(path.join(toolPaths(base).bin, 'gh'), 0o755);
  st = toolStatuses({ base, env: { GH_TOKEN: 't' } }).find((s) => s.name === 'gh')!;
  expect(st.installed).toBe(true);
  expect(st.authed).toBe(true);
});

it('getToolsSpawnEnv prepends bin to PATH and resolves envAlias', () => {
  const env = getToolsSpawnEnv({ base, env: { PATH: '/usr/bin', GITHUB_TOKEN: 'ght' } });
  expect(env.PATH.startsWith(toolPaths(base).bin + path.delimiter)).toBe(true);
  expect(env.GH_TOKEN).toBe('ght'); // aliased from GITHUB_TOKEN
});

it('awarenessNote lists installed tools and flags unauthed', () => {
  const note = awarenessNote([
    { name: 'jq', description: 'JSON', kind: 'binary', installed: true, authed: true },
    { name: 'gh', description: 'GitHub CLI', kind: 'binary', installed: true, authed: false },
    { name: 'aws', description: 'AWS', kind: 'script', installed: false, authed: false },
  ]);
  expect(note).toContain('jq');
  expect(note).toContain('gh');
  expect(note).not.toContain('aws'); // not installed
  expect(note.toLowerCase()).toContain('not authenticated'); // gh flagged
});

it('awarenessNote is empty when nothing installed', () => {
  expect(awarenessNote([{ name: 'x', description: 'd', kind: 'binary', installed: false, authed: false }])).toBe('');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/davidwebber/Sites/dispatch && pnpm --filter dispatch-server exec vitest run tests/tools/status.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `status.ts` (re-exports spawnEnv + awareness for one import site)**

```ts
// packages/core/src/tools/spawnEnv.ts
import path from 'node:path';
import { toolPaths } from './paths.js';
import { loadManifest } from './manifest.js';

export function getToolsSpawnEnv(opts?: { base?: string; env?: Record<string, string | undefined> }): Record<string, string> {
  const env = opts?.env ?? process.env;
  const p = toolPaths(opts?.base);
  const out: Record<string, string> = {};
  out.PATH = p.bin + path.delimiter + (env.PATH ?? '');
  for (const entry of loadManifest(opts?.base)) {
    for (const [want, src] of Object.entries(entry.envAlias ?? {})) {
      const v = env[src];
      if (v && !env[want]) out[want] = v;
    }
  }
  return out;
}
```

```ts
// packages/core/src/tools/awareness.ts
import type { ToolStatus } from './types.js';

export function awarenessNote(statuses: ToolStatus[]): string {
  const installed = statuses.filter((s) => s.installed);
  if (!installed.length) return '';
  const lines = installed.map((s) => `- \`${s.name}\` — ${s.description}${s.authed ? '' : ' (not authenticated — may fail until its credentials are set)'}`);
  return `## CLI tools available via Dispatch\n\nThese CLIs are installed and on your PATH; use them directly via shell commands when helpful.\n\n${lines.join('\n')}`;
}
```

```ts
// packages/core/src/tools/status.ts
import fs from 'node:fs';
import path from 'node:path';
import { toolPaths } from './paths.js';
import { loadManifest } from './manifest.js';
import type { ToolStatus } from './types.js';
export { getToolsSpawnEnv } from './spawnEnv.js';
export { awarenessNote } from './awareness.js';

export function toolStatuses(opts?: { base?: string; env?: Record<string, string | undefined> }): ToolStatus[] {
  const env = opts?.env ?? process.env;
  const p = toolPaths(opts?.base);
  return loadManifest(opts?.base).map((e) => {
    const installed = e.bins.every((b) => fs.existsSync(path.join(p.bin, b)));
    const authed = !e.authEnv?.length ? true : e.authEnv.every((k) => !!(env[k] || (e.envAlias && Object.entries(e.envAlias).some(([w, s]) => w === k && env[s]))));
    return { name: e.name, description: e.description, kind: e.kind, installed, authed, docs: e.docs };
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /Users/davidwebber/Sites/dispatch && pnpm --filter dispatch-server exec vitest run tests/tools/status.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
cd /Users/davidwebber/Sites/dispatch
git add packages/core/src/tools/status.ts packages/core/src/tools/spawnEnv.ts packages/core/src/tools/awareness.ts packages/core/tests/tools/status.test.ts
git commit -m "feat(tools): status, spawn-env (PATH + envAlias), awareness note"
```

---

### Task 5: Extend composeInjection with the developer note

**Files:**
- Modify: `packages/core/src/mcp/injection.ts`
- Test: `packages/core/tests/mcp/injection.test.ts` (create if absent; otherwise extend)

**Interfaces:**
- Consumes: existing `McpServerSpec`.
- Produces (changed signature): `composeInjection(specs, opts: { configPath: string; prompts: string[]; developerNote?: string | null }): { claudeConfigPath: string | null; codexArgs: string[]; systemPrompt: string | null }`.
  - `systemPrompt` = `[...prompts, developerNote].filter(Boolean).join('\n\n')` or `null`.
  - `codexArgs` includes `'-c', \`developer_instructions=${JSON.stringify(developerNote)}\`` when `developerNote` is set.
  - Works even when `specs` is empty (the early-return must not drop a developerNote/prompts).

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/tests/mcp/injection.test.ts
import { describe, it, expect } from 'vitest';
import { composeInjection } from '../../src/mcp/injection.js';

it('folds developerNote into systemPrompt and codex developer_instructions', () => {
  const r = composeInjection([], { configPath: '/tmp/mcp.json', prompts: [], developerNote: 'use jq' });
  expect(r.systemPrompt).toBe('use jq');
  const i = r.codexArgs.indexOf('developer_instructions=' + JSON.stringify('use jq'));
  expect(i).toBeGreaterThanOrEqual(0);
  expect(r.codexArgs[i - 1]).toBe('-c');
});

it('joins prompts and developerNote for the system prompt', () => {
  const r = composeInjection([], { configPath: '/x', prompts: ['mcp hint'], developerNote: 'tools note' });
  expect(r.systemPrompt).toBe('mcp hint\n\ntools note');
});

it('no developerNote → no developer_instructions arg', () => {
  const r = composeInjection([], { configPath: '/x', prompts: [] });
  expect(r.systemPrompt).toBeNull();
  expect(r.codexArgs.some((a) => a.startsWith('developer_instructions='))).toBe(false);
});

it('still emits mcp config + args when specs exist', () => {
  const r = composeInjection([{ name: 'srv', command: 'node', args: ['x.js'] }], { configPath: '/x/mcp.json', prompts: [], developerNote: 'n' });
  expect(r.claudeConfigPath).toBe('/x/mcp.json');
  expect(r.codexArgs.some((a) => a.startsWith('mcp_servers.srv.command='))).toBe(true);
  expect(r.codexArgs.some((a) => a.startsWith('developer_instructions='))).toBe(true);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/davidwebber/Sites/dispatch && pnpm --filter dispatch-server exec vitest run tests/mcp/injection.test.ts`
Expected: FAIL — `developerNote` ignored / early-return drops it.

- [ ] **Step 3: Edit `injection.ts`**

Replace the early-return and the final return. The current code is:
```ts
export function composeInjection(specs: McpServerSpec[], opts: { configPath: string; prompts: string[] }): { claudeConfigPath: string | null; codexArgs: string[]; systemPrompt: string | null } {
  if (specs.length === 0) return { claudeConfigPath: null, codexArgs: [], systemPrompt: null };
  // ... builds mcpServers + codexArgs, writes config file ...
  const prompts = opts.prompts.filter(Boolean);
  return { claudeConfigPath: opts.configPath, codexArgs, systemPrompt: prompts.length ? prompts.join('\n\n') : null };
}
```
Change the signature to accept `developerNote?: string | null`; remove the unconditional early return; build the system prompt and codex developer_instructions regardless of specs; only write the MCP config file + MCP `-c` args when `specs.length > 0`:
```ts
export function composeInjection(
  specs: McpServerSpec[],
  opts: { configPath: string; prompts: string[]; developerNote?: string | null },
): { claudeConfigPath: string | null; codexArgs: string[]; systemPrompt: string | null } {
  const codexArgs: string[] = [];
  let claudeConfigPath: string | null = null;

  if (specs.length > 0) {
    const mcpServers: Record<string, unknown> = {};
    for (const s of specs) {
      mcpServers[s.name] = { command: s.command, args: s.args, ...(s.env ? { env: s.env } : {}) };
      codexArgs.push('-c', `mcp_servers.${s.name}.command=${JSON.stringify(s.command)}`);
      codexArgs.push('-c', `mcp_servers.${s.name}.args=${JSON.stringify(s.args)}`);
      if (s.envVars?.length) codexArgs.push('-c', `mcp_servers.${s.name}.env_vars=${JSON.stringify(s.envVars)}`);
      if (s.env && !s.envVars?.length) for (const [k, v] of Object.entries(s.env)) codexArgs.push('-c', `mcp_servers.${s.name}.env.${k}=${JSON.stringify(v)}`);
    }
    fs.writeFileSync(opts.configPath, JSON.stringify({ mcpServers }, null, 2)); // keep the existing write exactly as it was
    claudeConfigPath = opts.configPath;
  }

  const note = opts.developerNote?.trim() ? opts.developerNote.trim() : null;
  if (note) codexArgs.push('-c', `developer_instructions=${JSON.stringify(note)}`);

  const sysParts = [...opts.prompts.filter(Boolean), ...(note ? [note] : [])];
  return { claudeConfigPath, codexArgs, systemPrompt: sysParts.length ? sysParts.join('\n\n') : null };
}
```
Preserve the EXACT existing config-file write (mkdir/format) from the current implementation — read the current `injection.ts` and keep its file-writing lines verbatim inside the `if (specs.length > 0)` block (the snippet above shows the shape; match the real code, including any `fs.mkdirSync`).

- [ ] **Step 4: Run the test + the existing provider tests**

Run:
```
cd /Users/davidwebber/Sites/dispatch
pnpm --filter dispatch-server exec vitest run tests/mcp/injection.test.ts tests/providers/providers.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/davidwebber/Sites/dispatch
git add packages/core/src/mcp/injection.ts packages/core/tests/mcp/injection.test.ts
git commit -m "feat(tools): composeInjection developerNote → Claude system prompt + Codex developer_instructions"
```

---

### Task 6: Wire tools into spawn + add the route

**Files:**
- Modify: `packages/core/src/sessions/service.ts` (add `setToolsAwareness`; pass `developerNote` to `composeInjection`)
- Modify: `packages/core/src/server.ts` (merge tools spawn-env into `setDefaultEnv`; `sessionService.setToolsAwareness(...)`; mount the route; thread `toolsDir` option)
- Create: `packages/core/src/routes/tools.ts`
- Test: `packages/core/tests/routes/tools.test.ts`

**Interfaces:**
- Consumes: `toolStatuses`, `getToolsSpawnEnv`, `awarenessNote` (Task 4); `createApp` options.
- Produces: `function createToolsRouter(opts?: { base?: string }): Router` → `GET /` → `{ tools: toolStatuses({ base }) }`. `SessionService.setToolsAwareness(fn: () => string | null)`.

- [ ] **Step 1: Write the failing route test**

```ts
// packages/core/tests/routes/tools.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import { createApp } from '../../src/server.js';

let toolsDir: string; let app: any;
beforeEach(() => {
  toolsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tools-rt-'));
  const db = new Database(':memory:'); initSchema(db);
  app = createApp({ db, skipPty: true, toolsDir });
});
afterEach(() => fs.rmSync(toolsDir, { recursive: true, force: true }));

it('GET /api/tools returns the manifest with status', async () => {
  const res = await request(app).get('/api/tools');
  expect(res.status).toBe(200);
  expect(Array.isArray(res.body.tools)).toBe(true);
  const jq = res.body.tools.find((t: any) => t.name === 'jq');
  expect(jq).toBeTruthy();
  expect(jq).toHaveProperty('installed');
  expect(jq).toHaveProperty('authed');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/davidwebber/Sites/dispatch && pnpm --filter dispatch-server exec vitest run tests/routes/tools.test.ts`
Expected: FAIL — route/option missing.

- [ ] **Step 3: Implement `routes/tools.ts`**

```ts
// packages/core/src/routes/tools.ts
import { Router } from 'express';
import { toolStatuses } from '../tools/status.js';

export function createToolsRouter(opts?: { base?: string }): Router {
  const router = Router();
  router.get('/', (_req, res) => {
    try { res.json({ tools: toolStatuses({ base: opts?.base }) }); }
    catch { res.json({ tools: [] }); }
  });
  return router;
}
```

- [ ] **Step 4: Add `setToolsAwareness` + pass `developerNote` in `service.ts`**

In `SessionService`, add a field + setter near the existing `setIntegrationsSpecs`:
```ts
private toolsAwareness?: () => string | null;
setToolsAwareness(fn: () => string | null): void { this.toolsAwareness = fn; }
```
In `spawnTerminal`, at the `composeInjection` call (currently line ~639), pass the note:
```ts
const developerNote = this.toolsAwareness?.() ?? null;
const secretsMcp = composeInjection(specs, { configPath: this.mcpConfigPath, prompts, developerNote });
```

- [ ] **Step 5: Wire `server.ts`**

1. Add `toolsDir?: string` to the `createApp`/`startServer` options type (find the options interface used at `server.ts:88` for `secretsDir`) and compute `const toolsBase = options.toolsDir ?? path.join(dataDir, 'tools');` near the `dataDir` resolution.
2. Merge tools spawn-env into the PTY default env. Find `refreshPtyEnv` (server.ts ~254) and the initial `setDefaultEnv` and include the tools env:
```ts
import { getToolsSpawnEnv } from './tools/spawnEnv.js';
import { toolStatuses, awarenessNote } from './tools/status.js';
// ...
const refreshPtyEnv = () => ptyManager.setDefaultEnv({ ...effectiveShimEnv, ...secretsService.getSpawnEnv(), ...getToolsSpawnEnv({ base: toolsBase }) });
```
   (Apply the same `...getToolsSpawnEnv({ base: toolsBase })` to the initial default-env construction if it's set separately.)
3. Register the awareness callback:
```ts
sessionService.setToolsAwareness(() => awarenessNote(toolStatuses({ base: toolsBase })));
```
4. Mount the router beside the others (server.ts ~322):
```ts
app.use('/api/tools', createToolsRouter({ base: toolsBase }));
```
(import `createToolsRouter` from `./routes/tools.js`.)

- [ ] **Step 6: Run the route test + full core suite**

Run:
```
cd /Users/davidwebber/Sites/dispatch
pnpm --filter dispatch-server exec vitest run tests/routes/tools.test.ts
pnpm --filter dispatch-server exec vitest run
pnpm --filter dispatch-server exec tsc --noEmit
```
Expected: tools route PASS; full suite green; tsc clean.

- [ ] **Step 7: Commit**

```bash
cd /Users/davidwebber/Sites/dispatch
git add packages/core/src/sessions/service.ts packages/core/src/server.ts packages/core/src/routes/tools.ts packages/core/tests/routes/tools.test.ts
git commit -m "feat(tools): spawn PATH/env + awareness injection + GET /api/tools"
```

---

### Task 7: `dispatch tools` CLI + bin wiring

**Files:**
- Create: `packages/core/src/tools/cli.ts`
- Modify: `bin/dispatch` (add `tools` subcommand; call `tools install` from `cmd_build`)
- Test: `packages/core/tests/tools/cli.test.ts`

**Interfaces:**
- Consumes: `loadManifest`, `installTool`, `uninstallTool`, `toolStatuses` (Tasks 2–4).
- Produces: `async function runToolsCli(argv: string[], opts?: { base?: string }): Promise<number>` (testable entrypoint) + a module that calls it with `process.argv.slice(2)` when run directly.

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/tests/tools/cli.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runToolsCli } from '../../src/tools/cli.js';
import { toolPaths } from '../../src/tools/paths.js';

let base: string;
beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'tools-cli-'));
  // user manifest with a single fake binary tool, so install is hermetic via a stub download is not available here;
  // instead test `list` which needs no network.
  fs.writeFileSync(path.join(path.dirname(base), 'tools.json'), JSON.stringify({ tools: [
    { name: 'demo', description: 'demo tool', kind: 'binary', bins: ['demo'], binary: { 'darwin-arm64': { url: 'https://x/demo', archive: 'none' }, 'darwin-x64': { url: 'https://x/demo', archive: 'none' } } },
  ] }));
});
afterEach(() => { fs.rmSync(base, { recursive: true, force: true }); fs.rmSync(path.join(path.dirname(base), 'tools.json'), { force: true }); });

it('list returns 0 and reports the manifest', async () => {
  const code = await runToolsCli(['list'], { base });
  expect(code).toBe(0);
});

it('uninstall removes a placed bin', async () => {
  fs.mkdirSync(toolPaths(base).bin, { recursive: true });
  fs.writeFileSync(path.join(toolPaths(base).bin, 'demo'), 'x');
  const code = await runToolsCli(['uninstall', 'demo'], { base });
  expect(code).toBe(0);
  expect(fs.existsSync(path.join(toolPaths(base).bin, 'demo'))).toBe(false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/davidwebber/Sites/dispatch && pnpm --filter dispatch-server exec vitest run tests/tools/cli.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `cli.ts`**

```ts
// packages/core/src/tools/cli.ts
import { loadManifest } from './manifest.js';
import { installTool, uninstallTool } from './installer.js';
import { toolStatuses } from './status.js';

export async function runToolsCli(argv: string[], opts?: { base?: string }): Promise<number> {
  const [cmd, name] = argv;
  const base = opts?.base;
  if (cmd === 'list' || cmd === 'status') {
    for (const s of toolStatuses({ base })) {
      console.log(`${s.installed ? '✓' : ' '} ${s.name.padEnd(14)} ${s.authed ? 'authed ' : 'no-auth'} ${s.kind}  ${s.description}`);
    }
    return 0;
  }
  if (cmd === 'install') {
    const manifest = loadManifest(base);
    const targets = name ? manifest.filter((e) => e.name === name) : manifest;
    if (!targets.length) { console.error(`no such tool: ${name}`); return 1; }
    let failed = 0;
    for (const e of targets) {
      try { console.log(`installing ${e.name}…`); await installTool(e, { base }); }
      catch (err) { failed++; console.error(`  ${e.name} failed: ${(err as Error).message}`); }
    }
    return failed ? 1 : 0;
  }
  if (cmd === 'uninstall') {
    if (!name) { console.error('usage: tools uninstall <name>'); return 1; }
    uninstallTool(name, base);
    return 0;
  }
  console.error('usage: dispatch tools <install|list|uninstall> [name]');
  return 1;
}

// Run directly: `node dist/tools/cli.js <args>`
const isMain = process.argv[1] && process.argv[1].endsWith('tools/cli.js');
if (isMain) { runToolsCli(process.argv.slice(2)).then((code) => process.exit(code)); }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /Users/davidwebber/Sites/dispatch && pnpm --filter dispatch-server exec vitest run tests/tools/cli.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Add the `tools` subcommand to `bin/dispatch`**

Add a `cmd_tools` function (near `cmd_run`) and a case entry. Use the same `$REPO` + node pattern as `cmd_run` (which runs `node "$SERVER_JS"`). The tools CLI entrypoint is `"$REPO/packages/core/dist/tools/cli.js"`:
```bash
cmd_tools() {
  ensure_built
  require_node
  node "$REPO/packages/core/dist/tools/cli.js" "$@"
}
```
Add to the case block (beside `run)`):
```bash
  tools)     shift; cmd_tools "$@" ;;
```
Add `tools` to the usage text near the other commands (the comment block at the top + the `usage()` body).

- [ ] **Step 6: Call `tools install` from `cmd_build`**

At the end of `cmd_build`, after the build succeeds, install tools (non-fatal — a tool failure shouldn't abort the build):
```bash
  bold "Installing bundled CLI tools…"
  node "$REPO/packages/core/dist/tools/cli.js" install || yellow "Some tools failed to install (continuing)."
  green "Build complete."
```
(Use whatever yellow/warn helper exists; if there's no `yellow`, use `red` or a plain `echo`. Keep the existing final `green "Build complete."` — move it after the tools step.)

- [ ] **Step 7: Build + smoke-test the CLI end to end**

Run:
```
cd /Users/davidwebber/Sites/dispatch
pnpm --filter dispatch-server build
node packages/core/dist/tools/cli.js list
```
Expected: build OK (confirm `dist/tools/default-tools.json` exists — Task 2 Step 4); `list` prints the default bundle (jq, ripgrep, gh, doppler, databricks, shopify, aws). If `default-tools.json` is missing from `dist`, fix the build copy step from Task 2.

- [ ] **Step 8: Commit**

```bash
cd /Users/davidwebber/Sites/dispatch
git add packages/core/src/tools/cli.ts packages/core/tests/tools/cli.test.ts bin/dispatch
git commit -m "feat(tools): dispatch tools CLI (install/list/uninstall) + build wiring"
```

---

### Task 8: Read-only Tools view in Settings

**Files:**
- Modify: `packages/web/src/api/types.ts` (add `ToolStatus`)
- Modify: `packages/web/src/api/client.ts` (add `getTools`)
- Create: `packages/web/src/components/settings/ToolsSection.tsx`
- Modify: `packages/web/src/components/settings/SettingsModal.tsx` (add the `tools` tab)
- Test: `packages/web/src/components/settings/ToolsSection.test.tsx`

**Interfaces:**
- Consumes: `api.getTools()`.
- Produces: web `interface ToolStatus { name: string; description: string; kind: 'binary'|'npm'|'script'; installed: boolean; version?: string; authed: boolean; docs?: string }`; `api.getTools(): Promise<{ tools: ToolStatus[] }>`; `<ToolsSection />`.

- [ ] **Step 1: Write the failing test**

```tsx
// packages/web/src/components/settings/ToolsSection.test.tsx
import { render, screen, waitFor } from '@testing-library/react';
import { vi, test, expect, afterEach } from 'vitest';
import { ToolsSection } from './ToolsSection';
import { api } from '../../api/client';

afterEach(() => vi.restoreAllMocks());

test('lists tools with installed + auth badges', async () => {
  vi.spyOn(api, 'getTools').mockResolvedValue({ tools: [
    { name: 'jq', description: 'JSON processor', kind: 'binary', installed: true, authed: true },
    { name: 'gh', description: 'GitHub CLI', kind: 'binary', installed: true, authed: false },
    { name: 'aws', description: 'AWS CLI', kind: 'script', installed: false, authed: false },
  ] });
  render(<ToolsSection />);
  await waitFor(() => expect(screen.getByText('jq')).toBeInTheDocument());
  expect(screen.getByText('GitHub CLI')).toBeInTheDocument();
  expect(screen.getByText('AWS CLI')).toBeInTheDocument();
  // gh is installed but not authed → shows a "needs auth" affordance
  expect(screen.getByText(/needs auth/i)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/davidwebber/Sites/dispatch && pnpm --filter dispatch-web exec vitest run src/components/settings/ToolsSection.test.tsx`
Expected: FAIL — module/method not found.

- [ ] **Step 3: Add the type + api method**

In `packages/web/src/api/types.ts` add:
```ts
export interface ToolStatus { name: string; description: string; kind: 'binary' | 'npm' | 'script'; installed: boolean; version?: string; authed: boolean; docs?: string }
```
In `packages/web/src/api/client.ts` add to the api object (beside `listIntegrations`):
```ts
getTools: () => req<{ tools: ToolStatus[] }>('/api/tools'),
```
(import `ToolStatus` in the client's type import list.)

- [ ] **Step 4: Implement `ToolsSection.tsx`**

```tsx
// packages/web/src/components/settings/ToolsSection.tsx
import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import type { ToolStatus } from '../../api/types';

const chip: React.CSSProperties = { fontSize: 10, textTransform: 'uppercase', letterSpacing: '.05em', color: 'var(--color-text-tertiary)', border: '1px solid #2c2c32', borderRadius: 5, padding: '1px 6px' };
const sub: React.CSSProperties = { fontSize: 12, color: 'var(--color-text-tertiary)' };

export function ToolsSection() {
  const [tools, setTools] = useState<ToolStatus[]>([]);
  const [err, setErr] = useState('');
  useEffect(() => { (async () => {
    try { setTools((await api.getTools()).tools); } catch { setErr('Could not reach Dispatch.'); }
  })(); }, []);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ fontSize: 12.5, color: 'var(--color-text-secondary)' }}>
        CLIs bundled with Dispatch and available to the agent in every thread. Add your own in <code>~/.dispatch/tools.json</code>, then run <code>dispatch tools install</code>.
      </div>
      {err && <div style={{ color: 'var(--color-status-red)', fontSize: 12 }}>{err}</div>}
      {tools.map((t) => (
        <div key={t.name} style={{ display: 'flex', alignItems: 'center', gap: 10, opacity: t.installed ? 1 : 0.5 }}>
          <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
              <span style={{ fontSize: 13, color: '#e9e9ec' }}>{t.name}</span>
              <span style={chip}>{t.kind}</span>
            </span>
            <span style={{ ...sub, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.description}</span>
          </span>
          {t.docs && <a href={t.docs} target="_blank" rel="noreferrer" style={{ ...sub, color: 'var(--color-accent)' }}>docs</a>}
          <span style={{ fontSize: 11, color: t.installed ? 'var(--color-status-green, #5fce7e)' : 'var(--color-text-tertiary)' }}>{t.installed ? 'installed' : 'not installed'}</span>
          <span style={{ fontSize: 11, color: t.authed ? 'var(--color-text-tertiary)' : 'var(--color-status-yellow)' }}>{t.authed ? 'authed' : 'needs auth'}</span>
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 5: Add the `tools` tab to `SettingsModal.tsx`**

- Extend the tab union (currently `'general' | 'integrations' | 'secrets'`) to include `'tools'`.
- Add `['tools', 'Tools']` to the tab-buttons array.
- Add the conditional render: `{tab === 'tools' && <ToolsSection />}` (import `ToolsSection`).

- [ ] **Step 6: Run the test + full web suite + tsc + build**

Run:
```
cd /Users/davidwebber/Sites/dispatch
pnpm --filter dispatch-web exec vitest run src/components/settings/ToolsSection.test.tsx
pnpm --filter dispatch-web exec vitest run
pnpm --filter dispatch-web exec tsc --noEmit
pnpm --filter dispatch-web build
```
Expected: all PASS; tsc clean; build OK.

- [ ] **Step 7: Commit**

```bash
cd /Users/davidwebber/Sites/dispatch
git add packages/web/src/api/types.ts packages/web/src/api/client.ts packages/web/src/components/settings/ToolsSection.tsx packages/web/src/components/settings/ToolsSection.test.tsx packages/web/src/components/settings/SettingsModal.tsx
git commit -m "feat(web): read-only Tools view in Settings"
```

---

## Manual verification (after Task 8; requires a daemon restart to load new core)

The route + spawn wiring are new core code, so go live with `pnpm --filter dispatch-server build && ./bin/dispatch restart` (ends the session). Then:
1. `dispatch tools install` (or it ran during `dispatch build`) → `dispatch tools list` shows the bundle installed. Spot-check `~/.dispatch/tools/bin` has `jq`, `rg`, `gh`, `doppler`, `databricks`, `shopify`, `aws`.
2. Verify the **aws** `script` entry actually placed `aws` in the prefix bin (the riskiest install); if not, adjust the `find` path in its script per the real `pkgutil --expand-full` layout.
3. In a **Claude** thread: ask "run `jq --version` and tell me which CLIs Dispatch told you are available" — confirm `jq` runs (PATH works) and the agent can recite the awareness note (system-prompt injection works).
4. In a **Codex** thread: same check — confirm the tools are on PATH and the agent is aware (the `-c developer_instructions` note). Confirm Codex still behaves normally (the note is additive, not a base-prompt replacement).
5. Settings → **Tools**: the list shows installed/authed badges; an authed tool (e.g. `gh` if `GITHUB_TOKEN`/`GH_TOKEN` is in Doppler) shows "authed".

## Self-Review notes (plan author)

- **Spec coverage:** prefix+PATH (Tasks 1,4,6); manifest default+user (Task 2); installer kinds binary/npm/script + optional sha256 + idempotency (Task 3); status/spawn-env/awareness (Task 4); auth via env + envAlias (Task 4, status/spawnEnv); awareness injection Claude `--append-system-prompt` + Codex `-c developer_instructions` (Tasks 5,6); CLI + build wiring (Task 7); read-only Settings view + `GET /api/tools` (Tasks 6,8); security tradeoff documented (spec + this plan's constraints). `configFile` deliberately deferred (Global Constraints) — covered by `envAlias`.
- **Type consistency:** `ToolEntry`/`ToolStatus`/`ToolPaths`, `loadManifest`, `installTool`/`uninstallTool`/`readInstalled`, `toolStatuses`/`getToolsSpawnEnv`/`awarenessNote`, `composeInjection(..., { developerNote })`, `setToolsAwareness`, `createToolsRouter`, `runToolsCli`, web `ToolStatus`/`getTools` — names used identically across tasks.
- **Known risk flagged:** the `default-tools.json` URLs/versions must be pinned to current releases at implementation time (and `aws`'s script verified on a real machine); `sha256` optional makes this safe to land incrementally.
