// Overseer memory scope (spec 2026-10-07), Unit 1 at the spawn site: a Claude overseer start
// passes --settings with its own memory folder, on spawn and on resume; a plain thread and an
// agent do not; the folder is created and seeded once. Everything runs in a fs.mkdtempSync folder
// (os.homedir is mocked to it too), and the test deletes only that folder.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overseer-memory-spawn-'));
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

it('without a memory home (tests, an unwired service) nothing is created and no --settings is passed', () => {
  const t = create('Control Plane', { role: 'coordinator' });
  expect(settingsOf(t.id)).toBeNull();
  expect(fs.readdirSync(home)).toEqual([]);
});
