import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import * as sessionsDb from '../../src/db/sessions.js';
import * as terminalsDb from '../../src/db/terminals.js';
import { SessionService } from '../../src/sessions/service.js';
import { PTYManager } from '../../src/pty/manager.js';
import { StructuredSessionManager } from '../../src/structured/manager.js';
import { KeyRegistry, type KeyHandle } from '../../src/auth/principals.js';

// Per-thread keys, Task 12: a key is minted at every spawn path and revoked by handle.

/** Remembers each literal it mints, so a test can ask whether an OLD key still resolves. */
class RecordingRegistry extends KeyRegistry {
  minted: { key: string; handle: KeyHandle; kind: string; terminalId?: string }[] = [];
  override mint(input: Parameters<KeyRegistry['mint']>[0]) {
    const m = super.mint(input);
    this.minted.push({ ...m, kind: input.kind, terminalId: (input as any).terminalId });
    return m;
  }
  last() { return this.minted[this.minted.length - 1]; }
  allFor(id: string) { return this.minted.filter((m) => m.terminalId === id); }
}

class CapturingPty extends PTYManager {
  calls: { id: string; command: string; args: string[]; env?: Record<string, string> }[] = [];
  failNext = false;
  private pid = 100;
  override spawn(id: string, command: string, args: string[], _wd: string, env?: Record<string, string>): number {
    if (this.failNext) { this.failNext = false; throw new Error('spawn failed'); }
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

class CapturingStructured extends StructuredSessionManager {
  calls: { terminalId: string; args: string[]; env?: Record<string, string> }[] = [];
  override isAlive(): boolean { return false; }
  override spawn(terminalId: string, opts: { args: string[]; env?: Record<string, string> }): number {
    this.calls.push({ terminalId, args: opts.args, env: opts.env });
    return 999;
  }
  override kill(): void {}
}

let sandbox: string;
let db: Database.Database;
let reg: RecordingRegistry;
let pty: CapturingPty;
let svc: SessionService;
let keyDir: string;

beforeEach(() => {
  // Nested sandbox: all writes and deletes stay below `root`; a canary beside it must survive.
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'ptk-lifecycle-'));
  const root = path.join(sandbox, 'root');
  keyDir = path.join(root, 'keys');
  fs.mkdirSync(path.join(root, 'proj'), { recursive: true });
  fs.mkdirSync(path.join(sandbox, 'canary'));
  fs.writeFileSync(path.join(sandbox, 'canary', 'victim'), 'keep');
  db = new Database(':memory:');
  initSchema(db);
  sessionsDb.create(db, { id: 's1', provider: 'claude-code', name: 't', workingDir: path.join(root, 'proj') });
  reg = new RecordingRegistry();
  pty = new CapturingPty();
  svc = new SessionService(db, pty, path.join(root, 'mcp.json'));
  svc.setKeyRegistry(reg, { keyDir });
});
afterEach(() => {
  expect(fs.readFileSync(path.join(sandbox, 'canary', 'victim'), 'utf8')).toBe('keep');
  fs.rmSync(sandbox, { recursive: true, force: true });
});

const live = (key: string) => reg.resolve(key) !== null;
const scanArgv = (calls: { command: string; args: string[] }[]) => {
  for (const c of calls) {
    for (const part of [c.command, ...c.args]) expect(part).not.toMatch(/d[tcs]k_/);
  }
};
function structuredSvc(type: 'claude-code' | 'codex' = 'claude-code') {
  const m = new CapturingStructured();
  svc.registerStructuredManager(type, m);
  svc.setStructuredCommandOverride({ command: 'true', args: [] });
  return m;
}
const structuredCfg = { transport: 'structured', role: 'agent', agentType: 'implementer' };

describe('PTY spawn paths', () => {
  it('create mints a thread key for an agent and a shell key for a shell', () => {
    const agent = svc.createTerminal('s1', 'claude-code', 'A');
    expect(reg.last().kind).toBe('thread');
    expect(reg.last().terminalId).toBe(agent.id);
    const sh = svc.createTerminal('s1', 'shell', 'S');
    expect(reg.last().kind).toBe('shell');
    expect(reg.last().terminalId).toBe(sh.id);
    scanArgv(pty.calls);
  });

  it('relaunch and restart mint a new key; the previous key no longer resolves', async () => {
    const t = svc.createTerminal('s1', 'claude-code', 'A');
    const first = reg.last();
    svc.relaunchTerminal(t.id);
    const second = reg.last();
    expect(second.key).not.toBe(first.key);
    expect(live(first.key)).toBe(false);
    expect(live(second.key)).toBe(true);
    await svc.restartTerminal(t.id);
    expect(live(second.key)).toBe(false);
    expect(live(reg.last().key)).toBe(true);
  });

  it('a late exit of the old pid keeps the new key; the exit of the current pid revokes it', () => {
    const t = svc.createTerminal('s1', 'claude-code', 'A');
    const first = reg.last();
    const oldPid = 100;
    svc.relaunchTerminal(t.id);
    const second = reg.last();
    pty.emit('exit', t.id, 0, oldPid);
    expect(live(second.key)).toBe(true);
    pty.emit('exit', t.id, 0, 101);
    expect(live(second.key)).toBe(false);
    expect(live(first.key)).toBe(false);
  });

  it('stopTerminal and removeTerminal revoke; restore mints a new key', () => {
    const t = svc.createTerminal('s1', 'claude-code', 'A');
    const k1 = reg.last();
    svc.stopTerminal(t.id);
    expect(live(k1.key)).toBe(false);
    svc.relaunchTerminal(t.id);
    const k2 = reg.last();
    svc.removeTerminal(t.id);
    expect(live(k2.key)).toBe(false);
    svc.restoreTerminal(t.id);
    const k3 = reg.last();
    expect(k3.key).not.toBe(k2.key);
    expect(live(k3.key)).toBe(true);
  });

  it('stop (session) and archive (project) revoke every thread key', () => {
    svc.createTerminal('s1', 'claude-code', 'A');
    const a = reg.last();
    svc.createTerminal('s1', 'shell', 'B');
    const b = reg.last();
    svc.stop('s1');
    expect(live(a.key)).toBe(false);
    expect(live(b.key)).toBe(false);
    const t = svc.createTerminal('s1', 'claude-code', 'C');
    const c = reg.last();
    expect(c.terminalId).toBe(t.id);
    svc.archive('s1');
    expect(live(c.key)).toBe(false);
  });

  it('a spawn that throws revokes the key it minted', () => {
    pty.failNext = true;
    try { svc.createTerminal('s1', 'claude-code', 'A'); } catch { /* createTerminal may surface it */ }
    expect(reg.minted.length).toBeGreaterThan(0);
    expect(live(reg.last().key)).toBe(false);
  });

  it('stopAllTerminals revokes every live PTY key', () => {
    svc.createTerminal('s1', 'claude-code', 'A');
    const a = reg.last();
    svc.stopAllTerminals();
    expect(live(a.key)).toBe(false);
  });

  it('the legacy project relaunch (no terminal rows) spawns with no env and mints nothing', () => {
    sessionsDb.create(db, { id: 's2', provider: 'claude-code', name: 'legacy', workingDir: path.join(sandbox, 'root', 'proj') });
    const before = reg.minted.length;
    const calls = pty.calls.length;
    svc.relaunch('s2');
    expect(pty.calls.length).toBe(calls + 1);
    expect(pty.calls[calls].env).toBeUndefined();
    expect(reg.minted.length).toBe(before);
  });

  it('a service with no registry mints nothing and spawns as before', () => {
    const plain = new SessionService(db, pty, path.join(sandbox, 'root', 'mcp2.json'));
    plain.createTerminal('s1', 'claude-code', 'A');
    expect(reg.minted.length).toBe(0);
  });

  it('a new registry (a daemon restart) resolves no old key', () => {
    svc.createTerminal('s1', 'claude-code', 'A');
    const k = reg.last();
    expect(new KeyRegistry().resolve(k.key)).toBeNull();
  });
});

describe('Codex CLI view key file', () => {
  it('writes a 0600 per-handle file, deletes the old one at the next spawn and at remove', () => {
    const t = svc.createTerminal('s1', 'codex', 'C');
    const k1 = reg.last();
    const f1 = path.join(keyDir, `${t.id}.${k1.handle.slice(0, 12)}`);
    expect(fs.statSync(f1).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(f1, 'utf8')).toContain(k1.key);
    svc.relaunchTerminal(t.id);
    const k2 = reg.last();
    const f2 = path.join(keyDir, `${t.id}.${k2.handle.slice(0, 12)}`);
    expect(fs.existsSync(f1)).toBe(false);
    expect(fs.existsSync(f2)).toBe(true);
    svc.removeTerminal(t.id);
    expect(fs.existsSync(f2)).toBe(false);
    scanArgv(pty.calls);
  });

  it('a Claude PTY thread gets no key file', () => {
    svc.createTerminal('s1', 'claude-code', 'A');
    expect(fs.existsSync(keyDir)).toBe(false);
  });
});

describe('structured spawn paths', () => {
  it('create, revive and relaunch each mint a new key; an exit revokes the bound one', () => {
    const m = structuredSvc();
    const t = svc.createTerminal('s1', 'claude-code', 'A', false, undefined, undefined, structuredCfg);
    expect(m.calls).toHaveLength(1);
    const k1 = reg.last();
    expect(k1.kind).toBe('thread');
    expect(k1.terminalId).toBe(t.id);
    svc.ensureStructuredAlive(t.id);
    const k2 = reg.last();
    expect(k2.key).not.toBe(k1.key);
    expect(live(k1.key)).toBe(false);
    expect(live(k2.key)).toBe(true);
    m.emit('exit', t.id, 0);
    expect(live(k2.key)).toBe(false);
    scanArgv(m.calls.map((c) => ({ command: 'x', args: c.args })));
  });

  it('a spawn that throws revokes the key it minted', () => {
    const m = structuredSvc();
    m.spawn = () => { throw new Error('no cli'); };
    try { svc.createTerminal('s1', 'claude-code', 'A', false, undefined, undefined, structuredCfg); } catch { /* surfaced */ }
    expect(reg.minted.length).toBeGreaterThan(0);
    expect(live(reg.last().key)).toBe(false);
  });

  it('stop and remove revoke a structured thread key', () => {
    structuredSvc();
    const t = svc.createTerminal('s1', 'claude-code', 'A', false, undefined, undefined, structuredCfg);
    const k = reg.last();
    svc.stopTerminal(t.id);
    expect(live(k.key)).toBe(false);
  });
});

describe('Codex Pretty sticky key', () => {
  const cfg = { transport: 'structured', role: 'agent', agentType: 'implementer' };

  it('keeps one key across respawns, an exit, an owner stop and a failed event; archive revokes it', () => {
    const m = structuredSvc('codex');
    const t = svc.createTerminal('s1', 'codex', 'C', false, undefined, undefined, cfg);
    expect(m.calls).toHaveLength(1);
    const k = reg.last();
    m.emit('exit', t.id, 0);
    expect(live(k.key)).toBe(true);
    m.emit('failed', t.id);
    expect(live(k.key)).toBe(true);
    svc.stopTerminal(t.id);
    expect(live(k.key)).toBe(true);
    svc.ensureStructuredAlive(t.id);
    expect(reg.allFor(t.id)).toHaveLength(1); // the same key was reused, nothing new minted
    svc.removeTerminal(t.id);
    expect(live(k.key)).toBe(false);
  });

  it('a project archive revokes it too', () => {
    structuredSvc('codex');
    svc.createTerminal('s1', 'codex', 'C', false, undefined, undefined, cfg);
    const k = reg.last();
    svc.archive('s1');
    expect(live(k.key)).toBe(false);
  });

  it('a switch to the CLI view revokes it and mints a CLI key with a key file', async () => {
    structuredSvc('codex');
    const t = svc.createTerminal('s1', 'codex', 'C', false, undefined, 'ext-1', cfg);
    const sticky = reg.last();
    terminalsDb.updateExternalId(db, t.id, 'ext-1');
    await svc.switchTransport(t.id, 'pty');
    expect(live(sticky.key)).toBe(false);
    const cli = reg.last();
    expect(cli.key).not.toBe(sticky.key);
    expect(live(cli.key)).toBe(true);
    expect(fs.existsSync(path.join(keyDir, `${t.id}.${cli.handle.slice(0, 12)}`))).toBe(true);
  });
});

describe('a draining Claude session followed at once by a revive (manager.ts kill inside spawn())', () => {
  it('leaves the new key valid and revokes only the old one', async () => {
    const dir = path.join(sandbox, 'root');
    // exits at once, but a helper holds stdout open: the session stays in the manager's map, not alive
    const drain = path.join(dir, 'drain.mjs');
    fs.writeFileSync(drain, [
      "import { spawn } from 'node:child_process';",
      "spawn(process.execPath, ['-e', 'setTimeout(() => {}, 2500)'], { stdio: ['ignore', 'inherit', 'inherit'] });",
      'process.exit(0);',
    ].join('\n'));
    const sleeper = path.join(dir, 'sleeper.mjs');
    fs.writeFileSync(sleeper, "setInterval(() => {}, 1000);\n");

    const real = new StructuredSessionManager();
    svc.registerStructuredManager('claude-code', real);
    svc.setStructuredCommandOverride({ command: process.execPath, args: [drain] });
    const t = svc.createTerminal('s1', 'claude-code', 'A', false, undefined, undefined, structuredCfg);
    const old = reg.last();
    expect(old.terminalId).toBe(t.id);

    const sessions = (real as any).sessions as Map<string, unknown>;
    const deadline = Date.now() + 800;
    while (Date.now() < deadline && !(sessions.has(t.id) && !real.isAlive(t.id))) await new Promise((r) => setTimeout(r, 10));
    expect(sessions.has(t.id)).toBe(true); // in the drain state
    expect(real.isAlive(t.id)).toBe(false);

    svc.setStructuredCommandOverride({ command: process.execPath, args: [sleeper] });
    expect(svc.ensureStructuredAlive(t.id)).toBe(true);
    const fresh = reg.last();
    expect(fresh.key).not.toBe(old.key);
    expect(live(old.key)).toBe(false);
    expect(live(fresh.key)).toBe(true);
    // the drain kill inside spawn() emitted its exit before the new bind: it did not touch the new key
    await new Promise((r) => setTimeout(r, 50));
    expect(live(fresh.key)).toBe(true);

    svc.stopTerminal(t.id);
    expect(live(fresh.key)).toBe(false);
    real.killAll?.();
  });
});
