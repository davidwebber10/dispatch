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
import { ThreadSpawner, disallowedToolsFor, CONVERSATION_LOST_NOTICE } from './thread-spawner.js';
import { clearTranscriptPathCache } from './transcript-path.js';
import { encodeClaudeProjectDir } from '../platform/encode.js';

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

describe('a saved Claude conversation with no transcript on disk', () => {
  let home: string;
  let savedHome: string | undefined;
  let posted: any[];
  beforeEach(() => {
    savedHome = process.env.HOME;
    home = path.join(tmp, 'home');
    fs.mkdirSync(path.join(home, '.claude', 'projects'), { recursive: true });
    process.env.HOME = home;
    clearTranscriptPathCache();
    posted = [];
    (mgr as any).postEvent = (id: string, ev: any) => posted.push({ id, ev });
  });
  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
    clearTranscriptPathCache();
  });

  it('starts a new conversation (no -r), clears the id, and says so in the thread', () => {
    terminalsDb.create(db, { id: 'g', sessionId: 's1', type: 'claude-code', label: 'g', externalId: 'ghost-1', config: { transport: 'structured' } });
    spawner.spawnTerminal('g');
    expect(mgr.spawns[0].opts.args).not.toContain('-r');
    expect(mgr.spawns[0].opts.resumeId).toBeUndefined();
    expect(terminalsDb.getById(db, 'g')!.external_id).toBeNull();
    expect(JSON.parse(terminalsDb.getById(db, 'g')!.config!).lostConversation.externalId).toBe('ghost-1');
    expect(posted).toHaveLength(1);
    expect(posted[0].ev).toMatchObject({ type: 'system', subtype: 'dispatch_notice', level: 'warning', message: CONVERSATION_LOST_NOTICE });
  });

  it('resumes with -r, and posts nothing, when the transcript is there', () => {
    const dir = path.join(home, '.claude', 'projects', encodeClaudeProjectDir(path.join(tmp, 'proj'), 'darwin'));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'real-1.jsonl'), '{}\n');
    terminalsDb.create(db, { id: 'r', sessionId: 's1', type: 'claude-code', label: 'r', externalId: 'real-1', config: { transport: 'structured' } });
    spawner.spawnTerminal('r');
    expect(mgr.spawns[0].opts.args).toContain('-r');
    expect(mgr.spawns[0].opts.args).toContain('real-1');
    expect(terminalsDb.getById(db, 'r')!.external_id).toBe('real-1');
    expect(posted).toEqual([]);
  });

  it('every Claude thread starts with a 30 second MCP startup timeout in its inline settings', () => {
    terminalsDb.create(db, { id: 'm', sessionId: 's1', type: 'claude-code', label: 'm', config: { transport: 'structured' } });
    spawner.spawnTerminal('m');
    const args: string[] = mgr.spawns[0].opts.args;
    const inline = args.filter((a, i) => args[i - 1] === '--settings').map((a) => JSON.parse(a));
    expect(inline.some((j) => j?.env?.MCP_TIMEOUT === '30000')).toBe(true);
  });
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
    expect(pty.spawns[0].env).toEqual({ DISPATCH_TERMINAL_ID: 'a', MCP_TIMEOUT: '30000' });
    const args = pty.spawns[0].args;
    expect(JSON.parse(args[args.indexOf('--settings') + 1])).toEqual({ env: { MCP_TIMEOUT: '30000' }, cleanupPeriodDays: 3650 });
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

describe('memory tools (spec 2026-11-17-memory-design.md, section 4.3)', () => {
  it('DISPATCH_MEMORY=1 only for a keyed thread while memory is on', () => {
    terminalsDb.create(db, { id: 'm', sessionId: 's1', type: 'codex', label: 'm', config: { transport: 'structured' } });
    let on = true;
    wiring.pluginInjection = () => ({ specs: [], prompts: [], toolNames: [], memoryTools: on });
    const env = (authEnv: boolean) => {
      const specs = [injection.agencyServerSpec('m', 's1', 0, authEnv)];
      injection.applyPluginInjection('m', 'codex', specs, []);
      return specs[0].env ?? {};
    };
    expect(env(true).DISPATCH_MEMORY).toBe('1');
    expect(env(false).DISPATCH_MEMORY).toBeUndefined(); // no key: no scope
    on = false;
    expect(env(true).DISPATCH_MEMORY).toBeUndefined();
  });
});

// Owner decision 2026-11-12: a chat thread on a hosted box has no status tool and no instruction to
// report a status; a thread with a role keeps both. On a local install (4.6.2) a thread the owner started
// has no report_status either (DISPATCH_REPORT_STATUS=0, no rule), and gets no hosted reply rule.
describe('a hosted chat thread: no status tool, the reply rule', () => {
  it('the dispatch server and the peer prompt, per thread kind', () => {
    terminalsDb.create(db, { id: 'chat', sessionId: 's1', type: 'claude-code', label: 'chat', config: { transport: 'structured' } });
    terminalsDb.create(db, { id: 'agent', sessionId: 's1', type: 'claude-code', label: 'agent', config: { transport: 'structured', role: 'agent' } });
    const local = injection.agencyServerSpec('chat', 's1', 0, false, false);
    expect(local.env?.DISPATCH_NO_STATUS_TOOL).toBeUndefined();
    expect(local.env?.DISPATCH_REPORT_STATUS).toBe('0');
    const localPrompt = injection.peerPromptFor(terminalsDb.getById(db, 'chat')!);
    expect(localPrompt).not.toContain('report_status');
    expect(localPrompt).not.toContain('YOUR REPLY IS THE ANSWER');
    expect(injection.peerPromptFor(terminalsDb.getById(db, 'agent')!)).toContain('report_status');
    const saved = { base: process.env.OS_BASE_URL, token: process.env.OS_BOX_TOKEN };
    process.env.OS_BASE_URL = 'http://platform.invalid'; process.env.OS_BOX_TOKEN = 'proof-token';
    try {
      expect(injection.isHostedChat('chat')).toBe(true);
      expect(injection.agencyServerSpec('chat', 's1', 0).env?.DISPATCH_NO_STATUS_TOOL).toBe('1');
      const prompt = injection.peerPromptFor(terminalsDb.getById(db, 'chat')!);
      expect(prompt).toContain('YOUR REPLY IS THE ANSWER');
      expect(prompt).not.toMatch(/report_status|report a status|status (tool|report|card)/i);
      expect(prompt).toContain('read_thread');
      expect(injection.isHostedChat('agent')).toBe(false);
      expect(injection.agencyServerSpec('agent', 's1', 0).env?.DISPATCH_NO_STATUS_TOOL).toBeUndefined();
      expect(injection.peerPromptFor(terminalsDb.getById(db, 'agent')!)).toContain('report_status');
    } finally {
      if (saved.base === undefined) delete process.env.OS_BASE_URL; else process.env.OS_BASE_URL = saved.base;
      if (saved.token === undefined) delete process.env.OS_BOX_TOKEN; else process.env.OS_BOX_TOKEN = saved.token;
    }
  });
});
