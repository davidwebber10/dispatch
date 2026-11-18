// Every way the daemon can start a process, counted (docs/hosted-privilege-separation.md, section 4).
//
// The spawn guard (src/privsep/spawn-guard.ts) replaces the process-creation entry points of
// `child_process` and of the PTY library. That covers every caller of those two modules, whatever file
// it is in. It does NOT cover a caller that reaches the operating system another way. So this file
// keeps three things true:
//
//   1. The files that can start a process are known (the list below). A new one fails this test until
//      a person adds it here, having checked that it uses only `child_process` or the PTY library's
//      `spawn`.
//   2. No daemon file uses another way to run code or start a process (a worker thread runs in the
//      daemon's own process, as the daemon's user; so do `vm` and a native add-on).
//   3. The guard covers every process-creating export of the two modules in THIS runtime: a Node or
//      library upgrade that adds an entry point fails here, not on a box.
import { describe, test, expect } from 'vitest';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PTY_ENTRY_POINTS, SYNC_ENTRY_POINTS } from '../../src/privsep/spawn-guard.js';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../src');

/** Every source file the daemon ships (tests and test fixtures are not shipped). */
function sourceFiles(dir: string = SRC, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { sourceFiles(full, out); continue; }
    if (!/\.(ts|js|mjs|cjs)$/.test(e.name) || /\.(test|fixture)\.[a-z]+$/.test(e.name) || e.name.endsWith('.d.ts')) continue;
    out.push(full);
  }
  return out;
}
const rel = (f: string): string => path.relative(SRC, f).split(path.sep).join('/');
/** The text of a file without comments, so a sentence ABOUT a module is not a use of it. */
const code = (f: string): string => fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/**
 * The files that can start a process: each imports `child_process` or the PTY library, and nothing
 * else in the daemon does. All of them go through the guard, because the guard changes the modules,
 * not the callers.
 */
const SPAWN_SITES = [
  'assist/run.ts',
  'auth/claude-cli-login.ts',
  'auth/claude-login.ts',
  'auth/codex-login.ts',
  'auth/codex-signout.ts',
  'auth/tailscale-access.ts',
  'docs/git.ts',
  'files/thumbnail.ts',
  'git/exec.ts',
  'inbox/write-file.ts', // `git check-ignore` after a secret file is written (child_process.execFile)
  'integrations/launcher.ts',
  'limits/claude-get-usage.ts',
  'limits/claude-usage.ts',
  'limits/codex-poll.ts',
  'overseer/github-link.ts',
  'overseer/ledger-checks.ts',
  'overseer/memory-scope.ts',
  'platform/daemon-darwin.ts',
  'platform/daemon-wsl.ts',
  'platform/darwin.ts',
  'platform/kill-grace.ts',
  'platform/wsl.ts',
  'plugins/hooks.ts',
  'plugins/marketplaces.ts',
  'plugins/workers.ts',
  'privsep/agent-fs.ts',
  'privsep/selfcheck.ts',
  'privsep/spawn-guard.ts',
  'providers/claude-prompt-file.ts',
  'pty/manager.ts',
  'routes/files.ts',
  'routes/git.ts',
  'sessions/cli-namer.ts',
  'setup/detect.ts',
  'setup/install.ts',
  'structured/manager.ts',
  'structured/shared/jsonrpc-client.ts',
  'tools/auth-probe.ts',
  'tools/installer.ts',
  'update/apply.ts',
];

/** Ways to run code or start a process that the guard does not see. None may appear in the daemon. */
const OTHER_WAYS: Array<[string, RegExp]> = [
  ['a worker thread (it runs as the daemon user, inside the daemon)', /['"](node:)?worker_threads['"]/],
  ['the cluster module', /['"](node:)?cluster['"]/],
  ['the vm module (code in the daemon\'s own process)', /['"](node:)?vm['"]/],
  ['an internal binding of the runtime', /process\.binding\s*\(|internalBinding\s*\(|process\._linkedBinding\s*\(/],
  ['a native add-on loaded by hand', /process\.dlopen\s*\(/],
  ['the PTY library\'s native binding', /\bpty\w*\.native\b|['"]node-pty\/[^'"]+['"]/],
  ['another process library', /['"](execa|cross-spawn|shelljs|node-cmd|child-process-promise|spawn-sync|foreground-child|ffi-napi|koffi)['"]/],
];

describe('every spawn site of the daemon goes through the guard', () => {
  const files = sourceFiles();

  test('the files that can start a process are exactly the known ones', () => {
    const found = files.filter((f) => /child_process|node-pty/.test(code(f))).map(rel).sort();
    // A file missing from the list: check that it uses only `child_process` or the PTY library's
    // `spawn`, then add it. A file that left: remove it.
    expect(found).toEqual([...SPAWN_SITES].sort());
  });

  test('no daemon file starts a process or runs code another way', () => {
    const hits: string[] = [];
    for (const f of files) {
      const text = code(f);
      for (const [what, re] of OTHER_WAYS) if (re.test(text)) hits.push(`${rel(f)}: ${what}`);
    }
    expect(hits).toEqual([]);
  });

  test('the PTY library is used only through `spawn`', () => {
    for (const f of files) {
      const text = code(f);
      if (!/['"]node-pty['"]/.test(text) || rel(f) === 'privsep/spawn-guard.ts') continue;
      // The namespace a file imports the library as, and every member it reads from it.
      const names = [...text.matchAll(/import\s+(?:\*\s+as\s+)?(\w+)\s+from\s+['"]node-pty['"]/g)].map((m) => m[1]);
      expect(names.length, rel(f)).toBeGreaterThan(0);
      for (const n of names) {
        const members = [...text.matchAll(new RegExp(`\\b${n}\\.(\\w+)`, 'g'))].map((m) => m[1]);
        for (const m of members) expect(['spawn', 'IPty', 'IDisposable', 'IEvent'], `${rel(f)}: ${n}.${m}`).toContain(m);
      }
    }
  });

  test('no spawn site asks for an identity of its own', () => {
    // The guard overrides `uid` and `gid` anyway; a caller that sets one shows a wrong idea of who decides.
    // (`uid: number` is a parameter's type, not an option.)
    const hits = files.filter((f) => SPAWN_SITES.includes(rel(f)) && !rel(f).startsWith('privsep/') && /\b(uid|gid)\s*:(?!\s*(number|string)\b)/.test(code(f))).map(rel);
    expect(hits).toEqual([]);
  });

  test('the guard is installed before any other module of the daemon loads', () => {
    const server = fs.readFileSync(path.join(SRC, 'server.ts'), 'utf8');
    const firstImport = /^\s*import\s[^\n]*$/m.exec(server)?.[0] ?? '';
    expect(firstImport).toMatch(/^import '\.\/privsep\/install\.js';/);
    // And the install step itself loads nothing that could start a process first.
    const install = code(path.join(SRC, 'privsep/install.ts'));
    const imports = [...install.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
    expect(imports.sort()).toEqual(['./config.js', './secrets.js', './spawn-guard.js', 'node:path']);
  });
});

describe('the guard covers every entry point of this runtime', () => {
  test('`child_process` has no process-creating export the guard does not know', () => {
    const exported = Object.keys(childProcess).filter((k) => typeof (childProcess as Record<string, unknown>)[k] === 'function').sort();
    // Through ChildProcess.prototype.spawn: spawn, exec, execFile, fork. By name: the three synchronous ones.
    // `_forkChild` sets up the IPC channel inside a forked child; it starts nothing.
    expect(exported).toEqual(['ChildProcess', '_forkChild', 'exec', 'execFile', 'execFileSync', 'execSync', 'fork', 'spawn', 'spawnSync'].sort());
    expect([...SYNC_ENTRY_POINTS].sort()).toEqual(['execFileSync', 'execSync', 'spawnSync']);
  });

  test('spawn, exec, execFile and fork all pass ChildProcess.prototype.spawn', async () => {
    const proto = childProcess.ChildProcess.prototype as unknown as { spawn: (o: unknown) => unknown };
    const original = proto.spawn;
    let passed = 0;
    proto.spawn = function counted(this: unknown, o: unknown) { passed++; return original.call(this, o); };
    try {
      const done = (c: childProcess.ChildProcess) => new Promise<void>((resolve) => { c.on('error', () => resolve()); c.on('close', () => resolve()); });
      const node = process.execPath;
      await done(childProcess.spawn(node, ['-e', '']));
      expect(passed).toBe(1);
      await done(childProcess.execFile(node, ['-e', '']));
      expect(passed).toBe(2);
      await done(childProcess.exec(`"${node}" -e ""`));
      expect(passed).toBe(3);
      await done(childProcess.fork('probe', [], { execArgv: ['-e', ''], silent: true }));
      expect(passed).toBe(4);
    } finally { proto.spawn = original; }
  });

  test('the PTY library has no process-creating export the guard does not replace', () => {
    const pty = createRequire(import.meta.url)('node-pty') as Record<string, unknown>;
    const functions = Object.keys(pty).filter((k) => typeof pty[k] === 'function').sort();
    // `open` makes a terminal pair with no process. Everything else that is a function starts one.
    expect(functions).toEqual([...PTY_ENTRY_POINTS, 'open'].sort());
  });
});
