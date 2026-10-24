import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import * as sessionsDb from '../../src/db/sessions.js';
import { SessionService } from '../../src/sessions/service.js';
import { PTYManager } from '../../src/pty/manager.js';
import { StructuredSessionManager } from '../../src/structured/manager.js';
import { CodexStructuredSessionManager } from '../../src/structured/codex-manager.js';
import { KeyRegistry, keyKindOf } from '../../src/auth/principals.js';
import { TERMINAL_ID_ENV_VAR } from '../../src/auth/shim.js';

// Per-thread keys, Task 13: how the key reaches each harness. The key is never in argv, never in
// the shared default env and never in the Codex app-server env.

const KEY_RE = /d[tcs]k_[A-Za-z0-9_-]{43}/;
const API = 'http://127.0.0.1:41999/base';

class CapturingPty extends PTYManager {
  calls: { id: string; command: string; args: string[]; env?: Record<string, string> }[] = [];
  private pid = 100;
  override spawn(id: string, command: string, args: string[], _wd: string, env?: Record<string, string>): number {
    this.calls.push({ id, command, args, env });
    return this.pid++;
  }
  override write(): void {}
  override resize(): void {}
  override kill(): void {}
  override getBuffer(): string { return ''; }
  override isAlive(): boolean { return false; }
  override killAll(): void {}
}

class CapturingClaude extends StructuredSessionManager {
  calls: { terminalId: string; command: string; args: string[]; env?: Record<string, string> }[] = [];
  override isAlive(): boolean { return false; }
  override spawn(terminalId: string, opts: { command: string; args: string[]; env?: Record<string, string> }): number {
    this.calls.push({ terminalId, command: opts.command, args: opts.args, env: opts.env });
    return 999;
  }
  override kill(): void {}
}

class CapturingCodex extends CodexStructuredSessionManager {
  calls: { terminalId: string; command: string; args: string[]; env?: Record<string, string>; threadConfig?: Record<string, any> }[] = [];
  override isAlive(): boolean { return false; }
  override spawn(terminalId: string, opts: { command: string; args: string[]; env?: Record<string, string>; threadConfig?: Record<string, unknown> }): number {
    this.calls.push({ terminalId, command: opts.command, args: opts.args, env: opts.env, threadConfig: opts.threadConfig as Record<string, any> });
    return 998;
  }
  override kill(): void {}
}

let sandbox: string;
let root: string;
let reg: KeyRegistry;
let pty: CapturingPty;
let svc: SessionService;
let keyDir: string;

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'ptk-delivery-'));
  root = path.join(sandbox, 'root');
  keyDir = path.join(root, 'keys');
  fs.mkdirSync(path.join(root, 'proj'), { recursive: true });
  fs.mkdirSync(path.join(sandbox, 'canary'));
  fs.writeFileSync(path.join(sandbox, 'canary', 'victim'), 'keep');
  const db = new Database(':memory:');
  initSchema(db);
  sessionsDb.create(db, { id: 's1', provider: 'claude-code', name: 't', workingDir: path.join(root, 'proj') });
  reg = new KeyRegistry();
  pty = new CapturingPty();
  svc = new SessionService(db, pty, path.join(root, 'mcp.json'));
  svc.setKeyRegistry(reg, { keyDir });
  svc.setDaemonApi(API);
});
afterEach(() => {
  expect(fs.readFileSync(path.join(sandbox, 'canary', 'victim'), 'utf8')).toBe('keep');
  fs.rmSync(sandbox, { recursive: true, force: true });
});

const scanArgv = (calls: { command: string; args: string[] }[]) => {
  for (const c of calls) for (const part of [c.command, ...c.args]) expect(part).not.toMatch(/d[tcs]k_/);
};
const cfgOf = (id: string) => path.join(root, `thread-${id}.mcp.json`);
const structuredCfg = { transport: 'structured', role: 'agent', agentType: 'implementer' };

describe('13a: environment', () => {
  it('a Claude PTY thread gets DISPATCH_AUTH with a thread key and the terminal id', () => {
    const t = svc.createTerminal('s1', 'claude-code', 'A');
    const env = pty.calls[0].env!;
    expect(env[TERMINAL_ID_ENV_VAR]).toBe(t.id);
    expect(keyKindOf(env.DISPATCH_AUTH)).toBe('thread');
    expect(env.DISPATCH_AUTH_FILE).toBeUndefined();
    expect(reg.resolve(env.DISPATCH_AUTH)).toMatchObject({ kind: 'thread', terminalId: t.id });
    scanArgv(pty.calls);
  });

  it('a shell tab gets a shell key', () => {
    svc.createTerminal('s1', 'shell', 'S');
    expect(keyKindOf(pty.calls[0].env!.DISPATCH_AUTH)).toBe('shell');
  });

  it('a Codex CLI thread gets DISPATCH_AUTH_FILE and no literal key', () => {
    svc.createTerminal('s1', 'codex', 'C');
    const env = pty.calls[0].env!;
    expect(env.DISPATCH_AUTH).toBeUndefined();
    expect(env.DISPATCH_AUTH_FILE?.startsWith(keyDir + path.sep)).toBe(true);
    expect(JSON.stringify(env)).not.toMatch(KEY_RE);
    const body = fs.readFileSync(env.DISPATCH_AUTH_FILE!, 'utf8').trim();
    expect(keyKindOf(body)).toBe('thread');
    expect(fs.statSync(env.DISPATCH_AUTH_FILE!).mode & 0o777).toBe(0o600);
    scanArgv(pty.calls);
  });

  it('a structured Claude thread gets DISPATCH_AUTH in its spawn env', () => {
    const m = new CapturingClaude();
    svc.registerStructuredManager('claude-code', m);
    svc.setStructuredCommandOverride({ command: 'true', args: [] });
    const t = svc.createTerminal('s1', 'claude-code', 'A', false, undefined, undefined, structuredCfg);
    const env = m.calls[0].env!;
    expect(env[TERMINAL_ID_ENV_VAR]).toBe(t.id);
    expect(reg.resolve(env.DISPATCH_AUTH)).toMatchObject({ kind: 'thread', terminalId: t.id });
    scanArgv(m.calls);
  });

  it('a Codex Pretty thread keeps env exactly {} (the key rides the thread config only)', () => {
    const m = new CapturingCodex();
    svc.registerStructuredManager('codex', m);
    svc.setStructuredCommandOverride({ command: 'true', args: [] });
    svc.createTerminal('s1', 'codex', 'C', false, undefined, undefined, structuredCfg);
    expect(m.calls).toHaveLength(1);
    expect(m.calls[0].env).toEqual({});
    scanArgv(m.calls);
  });

  it('the real Codex manager keeps the key out of the shared app-server env', () => {
    const real = new CodexStructuredSessionManager();
    const fake = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'structured', 'fake-codex-app-server.mjs');
    svc.registerStructuredManager('codex', real);
    svc.setStructuredCommandOverride({ command: process.execPath, args: [fake] });
    try {
      svc.createTerminal('s1', 'codex', 'C', false, undefined, undefined, structuredCfg);
      const spec = (real as any).connSpec as { env: Record<string, string>; args: string[] };
      expect(spec).toBeTruthy();
      expect(JSON.stringify(spec.env)).not.toMatch(KEY_RE);
      expect(spec.env.DISPATCH_AUTH).toBeUndefined();
      expect(spec.env.DISPATCH_AUTH_FILE).toBeUndefined();
      expect(spec.args.join(' ')).not.toMatch(KEY_RE);
    } finally {
      real.killAll();
    }
  });

  it('a service with no registry adds no key variable', () => {
    const db = new Database(':memory:');
    initSchema(db);
    sessionsDb.create(db, { id: 's1', provider: 'claude-code', name: 't', workingDir: path.join(root, 'proj') });
    const plain = new SessionService(db, pty, path.join(root, 'mcp2.json'));
    plain.createTerminal('s1', 'claude-code', 'A');
    expect(pty.calls[0].env).not.toHaveProperty('DISPATCH_AUTH');
    expect(pty.calls[0].env).not.toHaveProperty('DISPATCH_AUTH_FILE');
  });

  it('the agency server spec carries DISPATCH_API (not secret) and never the key', () => {
    const t = svc.createTerminal('s1', 'claude-code', 'A');
    const written = JSON.parse(fs.readFileSync(cfgOf(t.id), 'utf8'));
    expect(written.mcpServers.dispatch.env.DISPATCH_API).toBe(API);
  });
});

describe('13b: MCP injection', () => {
  it('a Claude PTY thread: the config file holds a reference to the variable, never the key', () => {
    const t = svc.createTerminal('s1', 'claude-code', 'A');
    const raw = fs.readFileSync(cfgOf(t.id), 'utf8');
    expect(raw).not.toMatch(KEY_RE);
    expect(JSON.parse(raw).mcpServers.dispatch.env.DISPATCH_AUTH).toBe('${DISPATCH_AUTH}');
    expect(fs.statSync(cfgOf(t.id)).mode & 0o777).toBe(0o600);
    scanArgv(pty.calls);
  });

  it('a Claude structured thread: same reference, key only in the spawn env', () => {
    const m = new CapturingClaude();
    svc.registerStructuredManager('claude-code', m);
    svc.setStructuredCommandOverride({ command: 'true', args: [] });
    const t = svc.createTerminal('s1', 'claude-code', 'A', false, undefined, undefined, structuredCfg);
    const raw = fs.readFileSync(cfgOf(t.id), 'utf8');
    expect(raw).not.toMatch(KEY_RE);
    expect(JSON.parse(raw).mcpServers.dispatch.env.DISPATCH_AUTH).toBe('${DISPATCH_AUTH}');
    scanArgv(m.calls);
  });

  it('a Codex CLI thread: env_vars passes the key-file path through; no key in argv', () => {
    const t = svc.createTerminal('s1', 'codex', 'C');
    const call = pty.calls[0];
    expect(call.args).toContain('mcp_servers.dispatch.env_vars=["DISPATCH_AUTH_FILE"]');
    expect(call.args).toContain(`mcp_servers.dispatch.env.DISPATCH_TERMINAL=${JSON.stringify(t.id)}`);
    expect(call.args).toContain(`mcp_servers.dispatch.env.DISPATCH_API=${JSON.stringify(API)}`);
    expect(call.args.join(' ')).not.toMatch(KEY_RE);
    scanArgv(pty.calls);
  });

  it('a Codex Pretty thread: thread config holds the literal key for the MCP server and the shell', () => {
    const m = new CapturingCodex();
    svc.registerStructuredManager('codex', m);
    svc.setStructuredCommandOverride({ command: 'true', args: [] });
    const t = svc.createTerminal('s1', 'codex', 'C', false, undefined, undefined, structuredCfg);
    const cfg = m.calls[0].threadConfig!;
    const key = cfg['shell_environment_policy.set.DISPATCH_AUTH'] as string;
    expect(reg.resolve(key)).toMatchObject({ kind: 'thread', terminalId: t.id });
    expect(cfg['mcp_servers.dispatch'].env.DISPATCH_AUTH).toBe(key);
    expect(cfg['mcp_servers.dispatch'].env_vars).toBeUndefined();
    expect(cfg['mcp_servers.dispatch'].env.DISPATCH_API).toBe(API);
    expect(cfg['shell_environment_policy.set.' + TERMINAL_ID_ENV_VAR]).toBe(t.id);
    // the app-server argv and env hold nothing
    expect(m.calls[0].env).toEqual({});
    scanArgv(m.calls);
    // the per-thread config file (Claude-style) never holds the literal
    expect(fs.readFileSync(cfgOf(t.id), 'utf8')).not.toContain(key);
    // a resume carries the same sticky key
    svc.stopTerminal(t.id);
    svc.ensureStructuredAlive(t.id);
    expect(m.calls[1].threadConfig!['shell_environment_policy.set.DISPATCH_AUTH']).toBe(key);
    expect(m.calls[1].threadConfig!['mcp_servers.dispatch'].env.DISPATCH_AUTH).toBe(key);
  });

  it('the other servers (secrets, integrations) never receive the key', () => {
    svc.setSecretsServerSpec(() => ({ spec: { name: 'doppler', command: 'node', args: ['d.js'], envVars: ['DOPPLER_TOKEN'] }, prompt: null }));
    svc.setIntegrationsSpecs(() => [{ name: 'fs', command: 'npx', args: [], env: { ROOT: '/tmp' } }]);
    const t = svc.createTerminal('s1', 'claude-code', 'A');
    const written = JSON.parse(fs.readFileSync(cfgOf(t.id), 'utf8'));
    expect(written.mcpServers.doppler.env).toBeUndefined();
    expect(written.mcpServers.fs.env).toEqual({ ROOT: '/tmp' });
    expect(written.mcpServers.dispatch.env.DISPATCH_AUTH).toBe('${DISPATCH_AUTH}');
  });

  it('a service with no registry writes no key reference', () => {
    const db = new Database(':memory:');
    initSchema(db);
    sessionsDb.create(db, { id: 's1', provider: 'claude-code', name: 't', workingDir: path.join(root, 'proj') });
    const plain = new SessionService(db, pty, path.join(root, 'mcp2.json'));
    const t = plain.createTerminal('s1', 'claude-code', 'A');
    const written = JSON.parse(fs.readFileSync(path.join(root, `thread-${t.id}.mcp.json`), 'utf8'));
    expect(written.mcpServers.dispatch.env.DISPATCH_AUTH).toBeUndefined();
  });
});

describe('13c: hooks', () => {
  function withHooks() {
    const hooksDir = path.join(root, 'hooks');
    svc.setStatusContext({
      serverUrl: API, hooksDir,
      codexHelperPath: '/opt/codex-notify.mjs', grokHelperPath: '/opt/grok-hook.mjs',
    });
    return hooksDir;
  }

  it('a Claude PTY thread: the hooks file is 0600, holds the header reference, and targets DISPATCH_API', () => {
    const hooksDir = withHooks();
    const t = svc.createTerminal('s1', 'claude-code', 'A');
    const file = path.join(hooksDir, `${t.id}.json`);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const raw = fs.readFileSync(file, 'utf8');
    expect(raw).not.toMatch(KEY_RE);
    const hook = JSON.parse(raw).hooks.Stop[0].hooks[0];
    expect(hook.headers).toEqual({ Authorization: 'Bearer ${DISPATCH_AUTH}' });
    expect(hook.allowedEnvVars).toEqual(['DISPATCH_AUTH']);
    // destination rule by construction: the hook URL is under the same address as DISPATCH_API
    const api = JSON.parse(fs.readFileSync(cfgOf(t.id), 'utf8')).mcpServers.dispatch.env.DISPATCH_API as string;
    expect(hook.url.startsWith(api + '/')).toBe(true);
    expect(pty.calls[0].env!.DISPATCH_AUTH).toMatch(/^dtk_/);
  });

  it('a service with no registry writes the hooks as before, with no header', () => {
    const db = new Database(':memory:');
    initSchema(db);
    sessionsDb.create(db, { id: 's1', provider: 'claude-code', name: 't', workingDir: path.join(root, 'proj') });
    const plain = new SessionService(db, pty, path.join(root, 'mcp3.json'));
    const hooksDir = path.join(root, 'hooks3');
    plain.setStatusContext({ serverUrl: API, hooksDir, codexHelperPath: '/x' });
    const t = plain.createTerminal('s1', 'claude-code', 'A');
    const raw = fs.readFileSync(path.join(hooksDir, `${t.id}.json`), 'utf8');
    expect(raw).not.toContain('headers');
  });

  it('a Codex CLI thread: the notify argv holds the URL only; the helper reads DISPATCH_AUTH_FILE', () => {
    withHooks();
    const t = svc.createTerminal('s1', 'codex', 'C');
    const notify = pty.calls[0].args.find((a) => a.startsWith('notify='))!;
    expect(JSON.parse(notify.slice('notify='.length))).toEqual(['node', '/opt/codex-notify.mjs', `${API}/api/events/codex/${t.id}`]);
    expect(pty.calls[0].env!.DISPATCH_AUTH_FILE).toBeTruthy();
    scanArgv(pty.calls);
  });
});
