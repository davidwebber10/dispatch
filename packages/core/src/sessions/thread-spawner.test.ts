// ThreadSpawner and SpawnInjection alone: built from their typed inputs, with no SessionService.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { initSchema } from '../db/schema.js';
import * as sessionsDb from '../db/sessions.js';
import * as terminalsDb from '../db/terminals.js';
import { KeyRegistry } from '../auth/principals.js';
import { ThreadConfigStore } from './thread-config.js';
import { ThreadKeys } from './thread-keys.js';
import { emptySessionWiring, type SessionWiring } from './session-wiring.js';
import { SpawnInjection, AGENCY_MCP_SERVER } from './spawn-injection.js';
import { ThreadSpawner, disallowedToolsFor } from './thread-spawner.js';

class FakePty {
  alive = new Set<string>();
  spawns: { id: string; args: string[]; cwd: string; env?: Record<string, string> }[] = [];
  isAlive(id: string) { return this.alive.has(id); }
  spawn(id: string, _command: string, args: string[], cwd: string, env?: Record<string, string>) { this.spawns.push({ id, args, cwd, env }); this.alive.add(id); return 4242; }
}

class FakeManager extends EventEmitter {
  live = new Set<string>();
  spawns: { id: string; opts: any }[] = [];
  fail: Error | null = null;
  isAlive(id: string) { return this.live.has(id); }
  spawn(id: string, opts: any) { if (this.fail) throw this.fail; this.spawns.push({ id, opts }); this.live.add(id); return 77; }
}

let tmp: string;
let db: Database.Database;
let pty: FakePty;
let mgr: FakeManager;
let reg: KeyRegistry;
let wiring: SessionWiring;
let injection: SpawnInjection;
let spawner: ThreadSpawner;
const savedCap = process.env.DISPATCH_MAX_LIVE_THREADS;
const mcpFile = (id: string) => path.join(tmp, 'data', `thread-${id}.mcp.json`);

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-spawner-'));
  fs.mkdirSync(path.join(tmp, 'proj'));
  db = new Database(':memory:');
  initSchema(db);
  sessionsDb.create(db, { id: 's1', provider: 'claude-code', name: 'p', workingDir: path.join(tmp, 'proj') });
  pty = new FakePty();
  mgr = new FakeManager();
  reg = new KeyRegistry();
  wiring = emptySessionWiring();
  wiring.threadKeys = new ThreadKeys(reg, { keyDir: path.join(tmp, 'keys') });
  wiring.daemonApi = 'http://127.0.0.1:41999';
  const configStore = new ThreadConfigStore(db);
  injection = new SpawnInjection({ db, configStore, wiring, mcpConfigPath: path.join(tmp, 'data', 'mcp.json') });
  spawner = new ThreadSpawner({
    db, configStore, pty: pty as any, wiring, injection,
    threads: { structuredManagerFor: (type) => (type === 'claude-code' ? (mgr as any) : undefined), codexEffortFor: () => undefined },
  });
});
afterEach(() => {
  if (savedCap === undefined) delete process.env.DISPATCH_MAX_LIVE_THREADS; else process.env.DISPATCH_MAX_LIVE_THREADS = savedCap;
  try { db.close(); } catch { /* noop */ }
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('ThreadSpawner', () => {
  it('a structured spawn writes the MCP config and mints one key', () => {
    terminalsDb.create(db, { id: 'p', sessionId: 's1', type: 'claude-code', label: 'p', config: { transport: 'structured' } });
    spawner.spawnTerminal('p');
    expect(mgr.spawns.length).toBe(1);
    expect(pty.spawns).toEqual([]);
    expect(reg.size()).toBe(1);
    expect(mgr.spawns[0].opts.env.DISPATCH_AUTH).toMatch(/^dtk_/);
    const written = JSON.parse(fs.readFileSync(mcpFile('p'), 'utf8'));
    expect(Object.keys(written.mcpServers)).toEqual([AGENCY_MCP_SERVER]);
    expect(JSON.stringify(written)).not.toContain(mgr.spawns[0].opts.env.DISPATCH_AUTH); // the file holds a reference, never the key
    spawner.spawnTerminal('p'); // alive: no second process, no second key
    expect(mgr.spawns.length).toBe(1);
    expect(reg.size()).toBe(1);
  });

  it('a spawn with no room in the project throws the cap error', () => {
    process.env.DISPATCH_MAX_LIVE_THREADS = '2';
    terminalsDb.create(db, { id: 'a', sessionId: 's1', type: 'claude-code', label: 'a' });
    terminalsDb.create(db, { id: 'b', sessionId: 's1', type: 'claude-code', label: 'b', config: { transport: 'structured' } });
    expect(() => spawner.assertRoomForLiveThread('s1')).not.toThrow();
    spawner.spawnTerminal('a');
    spawner.spawnTerminal('b');
    expect(spawner.liveThreadCount('s1')).toBe(2);
    expect(() => spawner.assertRoomForLiveThread('s1')).toThrow('This project already has 2 live threads (the limit is 2). Archive or stop some, or raise DISPATCH_MAX_LIVE_THREADS.');
    process.env.DISPATCH_MAX_LIVE_THREADS = '0';
    expect(() => spawner.assertRoomForLiveThread('s1')).not.toThrow();
  });

  it('a CLI spawn that throws revokes the key it minted', () => {
    terminalsDb.create(db, { id: 'a', sessionId: 's1', type: 'claude-code', label: 'a' });
    pty.spawn = () => { throw new Error('spawn ENOENT'); };
    expect(() => spawner.spawnTerminal('a')).toThrow('spawn ENOENT');
    expect(reg.size()).toBe(0);
  });

  it('a structured spawn that throws revokes its key and ensureStructuredAlive keeps the cause', () => {
    terminalsDb.create(db, { id: 'p', sessionId: 's1', type: 'claude-code', label: 'p', config: { transport: 'structured' } });
    mgr.fail = new Error('claude is not installed');
    expect(spawner.ensureStructuredAlive('p')).toBe(false);
    expect(spawner.lastSpawnError.get('p')).toBe('claude is not installed');
    expect(reg.size()).toBe(0);
    mgr.fail = null;
    expect(spawner.ensureStructuredAlive('p')).toBe(true);
    expect(spawner.lastSpawnError.has('p')).toBe(false);
  });

  it('a spawn with no key registry mints nothing and adds no key variable', () => {
    wiring.threadKeys = null;
    terminalsDb.create(db, { id: 'a', sessionId: 's1', type: 'claude-code', label: 'a' });
    spawner.spawnTerminal('a');
    expect(pty.spawns[0].env).toEqual({ DISPATCH_TERMINAL_ID: 'a' });
    expect(terminalsDb.getById(db, 'a')!.pid).toBe(4242);
  });

  it('a coordinator is never started on the CLI transport', () => {
    terminalsDb.create(db, { id: 'co', sessionId: 's1', type: 'claude-code', label: 'co', config: { role: 'coordinator' } });
    expect(() => spawner.spawnTerminal('co')).toThrow(/without a governed coordinator-capable structured transport/);
    expect(pty.spawns).toEqual([]);
  });

  it('disallowedToolsFor: only a coordinator and a role run lose tools', () => {
    expect(disallowedToolsFor({})).toBeUndefined();
    expect(disallowedToolsFor({ role: 'agent' })).toBeUndefined();
    expect(disallowedToolsFor({ role: 'coordinator' })!.length).toBeGreaterThan(0);
    expect(disallowedToolsFor({ roleAuthority: 'read' })!.length).toBeGreaterThan(0);
  });
});

describe('SpawnInjection', () => {
  it('the MCP config of a thread is one file beside the anchor path; removing it refuses a name that is not a plain id', () => {
    expect(injection.perTerminalMcpConfigPath('abc')).toBe(mcpFile('abc'));
    fs.mkdirSync(path.join(tmp, 'data'), { recursive: true });
    fs.writeFileSync(mcpFile('abc'), '{}');
    fs.writeFileSync(path.join(tmp, 'victim'), 'keep');
    for (const id of ['../victim', 'a/b', '..', '']) injection.removeThreadMcpConfig(id);
    expect(fs.existsSync(path.join(tmp, 'victim'))).toBe(true);
    injection.removeThreadMcpConfig('abc');
    expect(fs.existsSync(mcpFile('abc'))).toBe(false);
  });

  it('the address of the daemon: the set address, else the status context, else the bound port, else none', () => {
    expect(injection.apiUrl()).toBe('http://127.0.0.1:41999');
    wiring.daemonApi = null;
    expect(injection.apiUrl()).toBeNull();
    wiring.daemonPort = 4100;
    expect(injection.apiUrl()).toBe('http://127.0.0.1:4100');
    wiring.statusContext = { serverUrl: 'http://localhost:9/', hooksDir: tmp, codexHelperPath: '/x' };
    expect(injection.apiUrl()).toBe('http://localhost:9');
  });

  it('the plugin servers are added after the others and the thread row records every server name', () => {
    terminalsDb.create(db, { id: 'a', sessionId: 's1', type: 'claude-code', label: 'a', config: { keep: 1 } });
    const specs = [{ name: 'dispatch', command: 'node', args: [] }];
    const prompts: string[] = [];
    injection.applyPluginInjection('a', 'claude-code', specs, prompts); // no plugin system: nothing changes
    expect(specs.length).toBe(1);
    expect(JSON.parse(terminalsDb.getById(db, 'a')!.config!)).toEqual({ keep: 1 });
    const seen: [string, string[]][] = [];
    wiring.onSpawned = (id, tools) => { seen.push([id, tools]); };
    wiring.pluginInjection = (harness, sessionId) => ({ specs: [{ name: `plug-${harness}-${sessionId}`, command: 'node', args: [] }], prompts: ['use the plug'], toolNames: [] });
    injection.applyPluginInjection('a', 'claude-code', specs, prompts);
    expect(specs.map((s) => s.name)).toEqual(['dispatch', 'plug-claude-code-s1']);
    expect((specs[1] as { env?: Record<string, string> }).env).toEqual({ DISPATCH_API: 'http://127.0.0.1:41999' });
    expect(prompts).toEqual(['use the plug']);
    expect(JSON.parse(terminalsDb.getById(db, 'a')!.config!)).toEqual({ keep: 1, toolsAvailable: ['dispatch', 'plug-claude-code-s1'] });
    expect(seen).toEqual([['a', ['dispatch', 'plug-claude-code-s1']]]);
  });
});
