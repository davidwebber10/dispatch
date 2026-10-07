// Overseer memory scope (spec 2026-10-07), Unit 1 at the spawn site: a Claude overseer start
// passes --settings with its own memory folder, on spawn and on resume; a plain thread and an
// agent do not; the folder is created and seeded once. Everything runs in a fs.mkdtempSync folder
// (os.homedir is mocked to it too), and the test deletes only that folder.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'child_process';
import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type Database from 'better-sqlite3';
import { createDatabase } from '../../src/db/connection.js';
import * as sessionsDb from '../../src/db/sessions.js';
import * as terminalsDb from '../../src/db/terminals.js';
import { SessionService } from '../../src/sessions/service.js';
import type { IStructuredManager, StructuredSpawnOpts } from '../../src/structured/manager.js';
import { overseerMemoryDir, sharedProjectMemoryDir } from '../../src/overseer/memory-scope.js';

class FakePty extends EventEmitter {
  isAlive() { return false; }
  kill() {}
  spawn() { return 1234; }
  setDefaultEnv() {}
}

class FakeStructured extends EventEmitter implements IStructuredManager {
  live = new Set<string>();
  spawnOpts: Record<string, StructuredSpawnOpts> = {};
  setDefaultEnv() {}
  spawn(id: string, opts: StructuredSpawnOpts) { this.live.add(id); this.spawnOpts[id] = opts; return 4321; }
  sendMessage() {}
  answerPermission() { return false; }
  setEscalate() { return false; }
  interrupt() { return true; }
  compact() {}
  noteDeclaredStatus() {}
  getPending() { return null; }
  getSessionId() { return undefined; }
  getEvents() { return []; }
  getEventsTail() { return []; }
  getTurnTexts(): string[] | null { return null; }
  isAlive(id: string) { return this.live.has(id); }
  kill(id: string) { this.live.delete(id); this.emit('exit', id, 0); }
  killAll() { this.live.clear(); }
}

let dir: string;
let home: string;
let project: string;
let db: Database.Database;
let svc: SessionService;
let claude: FakeStructured;
let codex: FakeStructured;

beforeEach(() => {
  // Canonical: outside a git repository the shared folder keys on the canonical working directory.
  dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'overseer-memory-spawn-')));
  home = path.join(dir, 'home');
  project = path.join(dir, 'proj');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  vi.spyOn(os, 'homedir').mockReturnValue(home);
  db = createDatabase(path.join(dir, 'test.db'));
  sessionsDb.create(db, { id: 's1', provider: 'claude-code', name: 'proj', workingDir: project });
  svc = new SessionService(db, new FakePty() as any, path.join(dir, 'mcp.json'));
  claude = new FakeStructured();
  codex = new FakeStructured();
  svc.setStructuredManager(claude);
  svc.setCodexStructuredManager(codex);
});

afterEach(() => {
  vi.restoreAllMocks();
  try { db.close(); } catch { /* ignore */ }
  fs.rmSync(dir, { recursive: true, force: true });
});

/** The parsed `--settings` JSON of a spawn, or null when the flag is absent. */
function settingsOf(id: string): Record<string, unknown> | null {
  const args = claude.spawnOpts[id]?.args ?? [];
  const i = args.indexOf('--settings');
  return i === -1 ? null : JSON.parse(args[i + 1]);
}

const create = (label: string, config: Record<string, unknown>, externalId?: string) =>
  svc.createTerminal('s1', 'claude-code', label, false, undefined, externalId, { transport: 'structured', ...config });

describe('a Claude overseer start', () => {
  beforeEach(() => svc.setOverseerMemoryHome(home));

  it('passes --settings with its own memory folder on spawn, and creates the folder', () => {
    const t = create('Control Plane', { role: 'coordinator' });
    const own = overseerMemoryDir(home, project);
    expect(settingsOf(t.id)).toEqual({ autoMemoryDirectory: own });
    expect(fs.statSync(own).isDirectory()).toBe(true);
  });

  it('passes the same --settings on resume', () => {
    terminalsDb.create(db, { id: 'cp', sessionId: 's1', type: 'claude-code', label: 'Control Plane', workingDir: project, externalId: 'sess-cp', config: { transport: 'structured', role: 'coordinator' } });
    expect(svc.ensureStructuredAlive('cp')).toBe(true);
    const args = claude.spawnOpts.cp.args;
    expect(args.slice(args.indexOf('-r'), args.indexOf('-r') + 2)).toEqual(['-r', 'sess-cp']);
    expect(settingsOf('cp')).toEqual({ autoMemoryDirectory: overseerMemoryDir(home, project) });
  });

  it('a plain thread and an agent do not get it', () => {
    const plain = create('Scratch', {});
    const agent = create('Implementer', { role: 'agent', agentType: 'implementer' });
    expect(settingsOf(plain.id)).toBeNull();
    expect(settingsOf(agent.id)).toBeNull();
    expect(fs.existsSync(path.join(home, '.claude', 'dispatch-overseer'))).toBe(false);
  });

  it('a Codex overseer gets no Claude memory folder', () => {
    svc.createTerminal('s1', 'codex', 'Codex CP', false, undefined, undefined, { transport: 'structured', role: 'coordinator' });
    expect(fs.existsSync(path.join(home, '.claude', 'dispatch-overseer'))).toBe(false);
  });

  it("copies once the notes of this project's overseers, archived ones included", () => {
    const note = (origin: string) => `---\nname: n\noriginSessionId: ${origin}\n---\nbody\n`;
    const shared = sharedProjectMemoryDir(home, project);
    fs.mkdirSync(shared, { recursive: true });
    fs.writeFileSync(path.join(shared, 'MEMORY.md'), '- [Old](old.md)\n- [User](user.md)\n- [Agent](agent.md)\n');
    fs.writeFileSync(path.join(shared, 'old.md'), note('sess-old'));
    fs.writeFileSync(path.join(shared, 'user.md'), note('sess-user'));
    fs.writeFileSync(path.join(shared, 'agent.md'), note('sess-agent'));
    terminalsDb.create(db, { id: 'old', sessionId: 's1', type: 'claude-code', label: 'Old CP', externalId: 'sess-old', config: { transport: 'structured', role: 'coordinator' } });
    terminalsDb.archive(db, 'old');
    terminalsDb.create(db, { id: 'mine', sessionId: 's1', type: 'claude-code', label: 'Mine', externalId: 'sess-user', config: {} });
    terminalsDb.create(db, { id: 'impl', sessionId: 's1', type: 'claude-code', label: 'Impl', externalId: 'sess-agent', config: { role: 'agent' } });

    create('Control Plane', { role: 'coordinator' });

    const own = overseerMemoryDir(home, project);
    expect(fs.readdirSync(own).filter((n) => n.endsWith('.md')).sort()).toEqual(['MEMORY.md', 'old.md']);
    expect(fs.readFileSync(path.join(own, 'MEMORY.md'), 'utf8')).toBe('- [Old](old.md)\n');
    expect(fs.readdirSync(shared).sort()).toEqual(['MEMORY.md', 'agent.md', 'old.md', 'user.md']);
  });
});

// Unit 2: the policy each overseer gets at the spawn site.
describe('the write scope of an overseer', () => {
  beforeEach(() => svc.setOverseerMemoryHome(home));
  const writes = (policy: StructuredSpawnOpts['toolPolicy'], file: string) => policy!('Write', { file_path: file }).allow;
  const other = '/Users/someone/Projects/other';

  it("Claude: its own folder and this project's shared folder pass; another project and the rest of ~/.claude are refused", () => {
    const t = create('Control Plane', { role: 'coordinator' });
    const policy = claude.spawnOpts[t.id].toolPolicy;
    expect(writes(policy, path.join(overseerMemoryDir(home, project), 'MEMORY.md'))).toBe(true);
    expect(writes(policy, path.join(sharedProjectMemoryDir(home, project), 'from-the-overseer.md'))).toBe(true);
    expect(writes(policy, path.join(sharedProjectMemoryDir(home, other), 'MEMORY.md'))).toBe(false);
    expect(writes(policy, path.join(home, '.claude', 'settings.json'))).toBe(false);
  });

  it("Codex: its folder and this project's shared Claude folder pass; the Claude overseer's folder is refused", () => {
    const t = svc.createTerminal('s1', 'codex', 'Codex CP', false, undefined, undefined, { transport: 'structured', role: 'coordinator' });
    const policy = codex.spawnOpts[t.id].toolPolicy;
    expect(writes(policy, path.join(home, '.codex', 'dispatch-coordinator', 'MEMORY.md'))).toBe(true);
    expect(writes(policy, path.join(sharedProjectMemoryDir(home, project), 'from-the-overseer.md'))).toBe(true);
    expect(writes(policy, path.join(overseerMemoryDir(home, project), 'MEMORY.md'))).toBe(false);
    expect(writes(policy, path.join(home, '.codex', 'config.toml'))).toBe(false);
  });
});

// Unit 3: the persona of a start names the exact folders the policy allows.
describe('the persona of an overseer start', () => {
  beforeEach(() => svc.setOverseerMemoryHome(home));
  const line = (own: string) => `Your memory folder: ${own}. The project’s shared memory folder: ${sharedProjectMemoryDir(home, project)}.`;

  it('Claude: the persona ends with its own folder and the shared folder', () => {
    const t = create('Control Plane', { role: 'coordinator' });
    const args = claude.spawnOpts[t.id].args;
    const persona = args[args.lastIndexOf('--append-system-prompt') + 1];
    expect(persona.endsWith(line(overseerMemoryDir(home, project)))).toBe(true);
  });

  it('Codex: the developer instructions name its folder and the shared Claude folder', () => {
    const t = svc.createTerminal('s1', 'codex', 'Codex CP', false, undefined, undefined, { transport: 'structured', role: 'coordinator' });
    expect(codex.spawnOpts[t.id].systemPrompt).toContain(line(path.join(home, '.codex', 'dispatch-coordinator')));
  });

  it('a plain thread gets no folder line', () => {
    const t = create('Scratch', {});
    expect(claude.spawnOpts[t.id].args.join('\n')).not.toContain('Your memory folder:');
  });
});

/** The console.error lines of the memory scope. */
const memoryErrors = (spy: ReturnType<typeof vi.spyOn>) => spy.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith('[overseer-memory]'));

// Review round 1, fix 5: a missing home must not pass silently.
describe('without a memory home', () => {
  it('nothing is created, no --settings is passed, and the start logs that the overseer has no memory of its own', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const t = create('Control Plane', { role: 'coordinator' });
    expect(settingsOf(t.id)).toBeNull();
    expect(fs.readdirSync(home)).toEqual([]);
    const lines = memoryErrors(err);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(t.id);
    expect(lines[0]).toContain('without its own memory folder');
  });

  it('the test command seam and a plain thread log nothing', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    create('Scratch', {});
    svc.setStructuredCommandOverride({ command: 'node', args: ['-e', ''] });
    create('Control Plane', { role: 'coordinator' });
    expect(memoryErrors(err)).toEqual([]);
  });

  it('the daemon start sets the home: startServer calls setOverseerMemoryHome(os.homedir())', () => {
    const src = fs.readFileSync(new URL('../../src/server.ts', import.meta.url), 'utf8');
    const start = src.indexOf('export async function startServer(');
    expect(start).toBeGreaterThan(-1);
    const next = src.indexOf('\nexport ', start + 1);
    const body = src.slice(start, next === -1 ? undefined : next);
    expect(body).toMatch(/^\s*sessionService\.setOverseerMemoryHome\(os\.homedir\(\)\);/m);
  });
});

// Review round 1, fix 1: the shared folder follows the git repository, the own folder the working directory.
describe('an overseer in a subfolder of a git repository', () => {
  beforeEach(() => svc.setOverseerMemoryHome(home));

  it("gets the repository's shared folder: in the policy, the persona and the one-time copy", () => {
    const repo = path.join(dir, 'repo');
    const sub = path.join(repo, 'packages', 'core');
    fs.mkdirSync(sub, { recursive: true });
    const env = { ...process.env };
    for (const k of Object.keys(env)) if (k.startsWith('GIT_')) delete env[k];
    execFileSync('git', ['init', '-q'], { cwd: repo, env, stdio: 'ignore' });
    sessionsDb.create(db, { id: 's2', provider: 'claude-code', name: 'repo', workingDir: sub });
    const shared = sharedProjectMemoryDir(home, repo);
    fs.mkdirSync(shared, { recursive: true });
    fs.writeFileSync(path.join(shared, 'old.md'), `---\nname: n\noriginSessionId: sess-old\n---\nbody\n`);
    terminalsDb.create(db, { id: 'old2', sessionId: 's2', type: 'claude-code', label: 'Old CP', externalId: 'sess-old', config: { transport: 'structured', role: 'coordinator' } });
    terminalsDb.archive(db, 'old2');

    const t = svc.createTerminal('s2', 'claude-code', 'Control Plane', false, undefined, undefined, { transport: 'structured', role: 'coordinator' });

    const own = overseerMemoryDir(home, sub);
    expect(settingsOf(t.id)).toEqual({ autoMemoryDirectory: own });
    expect(fs.existsSync(path.join(own, 'old.md'))).toBe(true);
    const policy = claude.spawnOpts[t.id].toolPolicy!;
    expect(policy('Write', { file_path: path.join(shared, 'from-the-overseer.md') }).allow).toBe(true);
    expect(policy('Write', { file_path: path.join(sharedProjectMemoryDir(home, sub), 'x.md') }).allow).toBe(false);
    const args = claude.spawnOpts[t.id].args;
    expect(args[args.lastIndexOf('--append-system-prompt') + 1]).toContain(`The project’s shared memory folder: ${shared}.`);
  });
});

// Review round 2, fixes 1-2: when git cannot resolve the repository (here a separate git dir),
// the start defers the shared folder: own folder as usual, no shared folder, no copy, one line.
describe('an overseer whose repository could not be resolved', () => {
  beforeEach(() => svc.setOverseerMemoryHome(home));

  it('gets its own folder; the shared folder is left out of the policy, the persona and the copy; one error line', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const env = { ...process.env };
    for (const k of Object.keys(env)) if (k.startsWith('GIT_')) delete env[k];
    const sep = path.join(dir, 'sep');
    execFileSync('git', ['init', '-q', `--separate-git-dir=${path.join(dir, 'gitdir')}`, sep], { cwd: dir, env, stdio: 'ignore' });
    sessionsDb.create(db, { id: 's3', provider: 'claude-code', name: 'sep', workingDir: sep });
    const shared = sharedProjectMemoryDir(home, sep);
    fs.mkdirSync(shared, { recursive: true });
    fs.writeFileSync(path.join(shared, 'old.md'), `---\nname: n\noriginSessionId: sess-old\n---\nbody\n`);
    terminalsDb.create(db, { id: 'old3', sessionId: 's3', type: 'claude-code', label: 'Old CP', externalId: 'sess-old', config: { transport: 'structured', role: 'coordinator' } });
    terminalsDb.archive(db, 'old3');

    const t = svc.createTerminal('s3', 'claude-code', 'Control Plane', false, undefined, undefined, { transport: 'structured', role: 'coordinator' });

    const own = overseerMemoryDir(home, sep);
    expect(settingsOf(t.id)).toEqual({ autoMemoryDirectory: own });
    expect(fs.readdirSync(own)).toEqual([]); // no copy, no marker
    const policy = claude.spawnOpts[t.id].toolPolicy!;
    expect(policy('Write', { file_path: path.join(own, 'MEMORY.md') }).allow).toBe(true);
    expect(policy('Write', { file_path: path.join(shared, 'x.md') }).allow).toBe(false);
    const args = claude.spawnOpts[t.id].args;
    expect(args[args.lastIndexOf('--append-system-prompt') + 1]).not.toContain('shared memory folder:');
    const lines = memoryErrors(err);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(t.id);
    expect(lines[0]).toContain(sep);
  });
});

// Review round 1, fix 2: a symlink that leads a folder out of its memory root.
describe('a symlinked memory folder', () => {
  let outside: string;
  beforeEach(() => {
    svc.setOverseerMemoryHome(home);
    outside = path.join(dir, 'outside');
    fs.mkdirSync(outside);
  });

  it('own folder: no --settings, no setup, left out of the policy and the persona, one error line', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const own = overseerMemoryDir(home, project);
    fs.mkdirSync(path.dirname(own), { recursive: true });
    fs.symlinkSync(outside, own);

    const t = create('Control Plane', { role: 'coordinator' });

    expect(settingsOf(t.id)).toBeNull();
    expect(fs.readdirSync(outside)).toEqual([]);
    expect(claude.spawnOpts[t.id].toolPolicy!('Write', { file_path: path.join(own, 'MEMORY.md') }).allow).toBe(false);
    const args = claude.spawnOpts[t.id].args;
    expect(args[args.lastIndexOf('--append-system-prompt') + 1]).not.toContain('Your memory folder:');
    const lines = memoryErrors(err);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(own);
  });

  it('shared folder: nothing is copied, it is left out of the policy, one error line; the own folder still loads', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const shared = sharedProjectMemoryDir(home, project);
    fs.mkdirSync(path.dirname(shared), { recursive: true });
    fs.symlinkSync(outside, shared);
    fs.writeFileSync(path.join(outside, 'planted.md'), `---\nname: n\noriginSessionId: sess-old\n---\nbody\n`);
    terminalsDb.create(db, { id: 'old', sessionId: 's1', type: 'claude-code', label: 'Old CP', externalId: 'sess-old', config: { transport: 'structured', role: 'coordinator' } });
    terminalsDb.archive(db, 'old');

    const t = create('Control Plane', { role: 'coordinator' });

    const own = overseerMemoryDir(home, project);
    expect(settingsOf(t.id)).toEqual({ autoMemoryDirectory: own });
    expect(fs.readdirSync(own)).toEqual([]);
    expect(claude.spawnOpts[t.id].toolPolicy!('Write', { file_path: path.join(shared, 'from-the-overseer.md') }).allow).toBe(false);
    const lines = memoryErrors(err);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(shared);
  });
});
