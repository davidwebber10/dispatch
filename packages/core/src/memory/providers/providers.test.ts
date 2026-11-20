import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { claudeProvider, INDEX, INDEX_LIMIT } from './claude.js';
import { codexProvider, SECTION_START, SECTION_END, INSTRUCTIONS_REL } from './codex.js';
import { grokProvider } from './grok.js';
import { opencodeProvider } from './opencode.js';
import { readInside, writeInside, safeFsTest } from './safe-fs.js';
import { MemoryService, projectsFromDb } from '../service.js';
import { buildProviders } from './index.js';
import { updateMemorySettings } from '../settings.js';
import { initSchema } from '../../db/schema.js';
import * as sessionsDb from '../../db/sessions.js';
import * as store from '../../db/memory.js';
import Database from 'better-sqlite3';
import { sharedProjectMemoryDir } from '../../overseer/memory-scope.js';
import type { ProviderScope } from './types.js';

/** The memory providers against fixture homes (spec 2026-11-17-memory-design.md, 4.8); no real home folder. */
describe('memory providers', () => {
  let home: string;
  const project: ProviderScope = { scope: 'project:A', workingDir: '/work/app' };
  const claude = () => claudeProvider({ home, env: {}, projectDir: (w) => w });
  const claudeDir = () => sharedProjectMemoryDir(home, '/work/app');

  beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-prov-')); });
  afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

  describe('status per harness', () => {
    it('not installed without the harness folder; Claude on by default, off by its setting or env', () => {
      expect(claude().status(project).state).toBe('not-installed');
      fs.mkdirSync(path.join(home, '.claude'));
      expect(claude().status(project)).toMatchObject({ native: true, state: 'on', location: claudeDir() });
      fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ autoMemoryEnabled: false }));
      expect(claude().status(project).state).toBe('off');
      expect(claudeProvider({ home: fs.mkdtempSync(path.join(os.tmpdir(), 'x-')), env: {} }).status(null).state).toBe('not-installed');
    });

    it('Codex: off until it has memory files; on with them', () => {
      const codex = codexProvider({ home, env: {} });
      expect(codex.status(null).state).toBe('not-installed');
      fs.mkdirSync(path.join(home, '.codex'));
      expect(codex.status(null).state).toBe('off');
      fs.mkdirSync(path.join(home, '.codex', 'memories_v2'));
      fs.writeFileSync(path.join(home, '.codex', 'memories_v2', 'memory_summary.md'), '# Summary\nUses pnpm.\n');
      expect(codex.status(null).state).toBe('on');
      expect(codex.list({ scope: 'you' })).toEqual([expect.objectContaining({ rel: 'memories_v2/memory_summary.md', writable: false })]);
    });

    it('Grok: off by default, on with GROK_MEMORY=1 or [memory] enabled = true', () => {
      fs.mkdirSync(path.join(home, '.grok'));
      expect(grokProvider({ home, env: {} }).status(null).state).toBe('off');
      expect(grokProvider({ home, env: { GROK_MEMORY: '1' } }).status(null).state).toBe('on');
      fs.writeFileSync(path.join(home, '.grok', 'config.toml'), '[ui]\ntheme = "x"\n\n[memory]\nenabled = true\n');
      expect(grokProvider({ home, env: {} }).status(null).state).toBe('on');
    });

    it('OpenCode: no memory of its own', () => {
      expect(opencodeProvider().status(null)).toEqual({ native: false, state: 'not-supported', location: null });
      expect(opencodeProvider().capabilities.write).toBe('none');
    });
  });

  describe('Claude Code', () => {
    beforeEach(() => {
      fs.mkdirSync(claudeDir(), { recursive: true });
      fs.writeFileSync(path.join(claudeDir(), INDEX), '- [Tests](testing.md) — how to run tests\n');
      fs.writeFileSync(path.join(claudeDir(), 'testing.md'), '---\nname: testing\ndescription: How to run the tests\nmetadata:\n  type: feedback\n---\nRun with FOO=1.\n');
    });

    it('lists one entry per file; MEMORY.md is never an entry', () => {
      const list = claude().list(project);
      expect(list.map((e) => e.rel)).toEqual(['testing.md']);
      expect(list[0]).toMatchObject({ title: 'testing', description: 'How to run the tests', writable: true });
      expect(claude().read(project, INDEX)).toBeNull();
    });

    it('a new entry is a new file plus one appended index line; the old lines stay', () => {
      const r = claude().write!(project, { title: 'Deploy rules', description: 'Stage first', text: 'Deploy to stage, then prod.' }, null);
      expect(r).toEqual({ ok: true, rel: 'deploy-rules.md' });
      const index = fs.readFileSync(path.join(claudeDir(), INDEX), 'utf8');
      expect(index).toBe('- [Tests](testing.md) — how to run tests\n- [Deploy rules](deploy-rules.md) — Stage first\n');
      expect(fs.readFileSync(path.join(claudeDir(), 'deploy-rules.md'), 'utf8')).toContain('name: Deploy rules\ndescription: Stage first');
    });

    it('refuses a new entry when the index is near 200 lines', () => {
      fs.writeFileSync(path.join(claudeDir(), INDEX), Array.from({ length: INDEX_LIMIT }, (_, i) => `- line ${i}`).join('\n') + '\n');
      const r = claude().write!(project, { title: 'One more', text: 'x' }, null);
      expect(r).toMatchObject({ ok: false, conflict: false });
      expect(fs.existsSync(path.join(claudeDir(), 'one-more.md'))).toBe(false);
    });

    it('an edit from a stale copy is refused with the new text; nothing is overwritten', () => {
      const seen = claude().read(project, 'testing.md')!;
      fs.writeFileSync(path.join(claudeDir(), 'testing.md'), 'changed by Claude\n');
      const r = claude().write!(project, { rel: 'testing.md', title: 'testing', text: 'my edit' }, seen.sha);
      expect(r).toMatchObject({ ok: false, conflict: true, current: { text: 'changed by Claude\n' } });
      expect(fs.readFileSync(path.join(claudeDir(), 'testing.md'), 'utf8')).toBe('changed by Claude\n');
      const fresh = claude().read(project, 'testing.md')!;
      expect(claude().write!(project, { rel: 'testing.md', title: 'testing', text: 'my edit' }, fresh.sha)).toEqual({ ok: true, rel: 'testing.md' });
    });

    it('a delete removes the file and its index line', () => {
      const seen = claude().read(project, 'testing.md')!;
      expect(claude().remove!(project, 'testing.md', seen.sha)).toEqual({ ok: true, rel: 'testing.md' });
      expect(fs.existsSync(path.join(claudeDir(), 'testing.md'))).toBe(false);
      expect(fs.readFileSync(path.join(claudeDir(), INDEX), 'utf8')).toBe('');
    });

    it('a symlink is never followed: not listed, not read, and a write replaces the link, not its target', () => {
      const outside = path.join(home, 'secret.txt');
      fs.writeFileSync(outside, 'do not read me');
      fs.symlinkSync(outside, path.join(claudeDir(), 'link.md'));
      expect(claude().list(project).map((e) => e.rel)).toEqual(['testing.md']);
      expect(claude().read(project, 'link.md')).toBeNull();
      expect(readInside({ dir: claudeDir(), base: home }, 'link.md')).toBeNull();
      // A link swapped in for a file between the check and the write: the rename replaces the link.
      const seen = claude().read(project, 'testing.md')!;
      fs.rmSync(path.join(claudeDir(), 'testing.md'));
      fs.symlinkSync(outside, path.join(claudeDir(), 'testing.md'));
      expect(claude().write!(project, { rel: 'testing.md', title: 't', text: 'x' }, seen.sha)).toMatchObject({ ok: false, conflict: true });
      writeInside({ dir: claudeDir(), base: home }, 'testing.md', 'written');
      expect(fs.readFileSync(outside, 'utf8')).toBe('do not read me');
      expect(fs.lstatSync(path.join(claudeDir(), 'testing.md')).isSymbolicLink()).toBe(false);
      // A path out of the root is refused.
      expect(readInside({ dir: claudeDir(), base: home }, '../../secret.txt')).toBeNull();
      expect(() => writeInside({ dir: claudeDir(), base: home }, '../x.md', 'x')).toThrow(/not inside/);
    });
  });

  describe('Codex instructions', () => {
    beforeEach(() => { fs.mkdirSync(path.join(home, '.codex')); fs.writeFileSync(path.join(home, '.codex', 'AGENTS.md'), '# My rules\n\nBe brief.\n'); });

    it('a marked section of ~/.codex/AGENTS.md: added once, the rest of the file untouched', () => {
      const codex = codexProvider({ home, env: {} });
      expect(codex.write!({ scope: 'you' }, { title: '', text: 'Use pnpm, not npm.' }, null)).toEqual({ ok: true, rel: INSTRUCTIONS_REL });
      const once = fs.readFileSync(path.join(home, '.codex', 'AGENTS.md'), 'utf8');
      expect(once).toBe(`# My rules\n\nBe brief.\n\n${SECTION_START}\n- Use pnpm, not npm.\n${SECTION_END}\n`);
      codex.write!({ scope: 'you' }, { title: '', text: 'Use pnpm, not npm.' }, null);
      expect(fs.readFileSync(path.join(home, '.codex', 'AGENTS.md'), 'utf8')).toBe(once);
      codex.write!({ scope: 'you' }, { title: '', text: 'Run tests with FOO=1.' }, null);
      const ins = codex.read({ scope: 'you' }, INSTRUCTIONS_REL)!;
      expect(ins.text).toBe('- Use pnpm, not npm.\n- Run tests with FOO=1.');
      expect(codex.write!({ scope: 'you' }, { rel: INSTRUCTIONS_REL, title: '', text: 'replaced' }, 'stale')).toMatchObject({ conflict: true });
      expect(codex.write!({ scope: 'you' }, { rel: INSTRUCTIONS_REL, title: '', text: '- only this' }, ins.sha)).toMatchObject({ ok: true });
      expect(fs.readFileSync(path.join(home, '.codex', 'AGENTS.md'), 'utf8')).toBe(`# My rules\n\nBe brief.\n\n${SECTION_START}\n- only this\n${SECTION_END}\n`);
    });

    it('Codex memory files are read-only for Dispatch', () => {
      const codex = codexProvider({ home, env: {} });
      expect(codex.write!({ scope: 'you' }, { rel: 'memories_v2/MEMORY.md', title: '', text: 'x' }, 'x')).toMatchObject({ ok: false, conflict: false });
    });
  });

  describe('Grok', () => {
    it('writes topics only, and only when its memory is on; MEMORY.md is not an entry', () => {
      const topics = path.join(home, '.grok', 'memory-v2', 'global', 'topics');
      fs.mkdirSync(topics, { recursive: true });
      fs.writeFileSync(path.join(home, '.grok', 'memory-v2', 'global', 'MEMORY.md'), 'generated');
      expect(grokProvider({ home, env: {} }).write!({ scope: 'you' }, { title: 'Tea', text: 'Green' }, null)).toMatchObject({ ok: false });
      const grok = grokProvider({ home, env: { GROK_MEMORY: '1' } });
      expect(grok.write!({ scope: 'you' }, { title: 'Tea', text: 'Green' }, null)).toEqual({ ok: true, rel: 'global/topics/tea.md' });
      expect(grok.list({ scope: 'you' }).map((e) => e.rel)).toEqual(['global/topics/tea.md']);
    });
  });

  // Security review F9: a link at a FOLDER on the path (the memory folder itself, or a parent) must not
  // lead the daemon (root on a box) to read a place outside the provider root.
  describe('a link at a folder on the path', () => {
    let outside: string;
    beforeEach(() => {
      outside = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-outside-')); // stands for the root-only state folder
      fs.writeFileSync(path.join(outside, 'state.md'), '---\nname: state\n---\nROOT ONLY\n');
      fs.writeFileSync(path.join(outside, MEMORY_INDEX()), '');
    });
    afterEach(() => { fs.rmSync(outside, { recursive: true, force: true }); safeFsTest.mode = undefined; safeFsTest.beforeOpen = null; });
    const MEMORY_INDEX = () => INDEX;

    it('the memory folder itself is a link: refused', () => {
      fs.mkdirSync(path.dirname(claudeDir()), { recursive: true });
      fs.symlinkSync(outside, claudeDir());
      expect(claude().list(project)).toEqual([]);
      expect(claude().read(project, 'state.md')).toBeNull();
      expect(claude().write!(project, { title: 'x', text: 'y' }, null)).toMatchObject({ ok: false });
      expect(fs.readdirSync(outside).sort()).toEqual([INDEX, 'state.md']);
    });

    it('a parent folder is a link: refused', () => {
      fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
      fs.mkdirSync(path.join(outside, 'deep', path.basename(path.dirname(claudeDir())), 'memory'), { recursive: true });
      fs.writeFileSync(path.join(outside, 'deep', path.basename(path.dirname(claudeDir())), 'memory', 'state.md'), 'ROOT ONLY');
      fs.symlinkSync(path.join(outside, 'deep'), path.join(home, '.claude', 'projects'));
      expect(claude().list(project)).toEqual([]);
      expect(claude().read(project, 'state.md')).toBeNull();
    });

    it('a folder swapped for a link during a read: refused', () => {
      fs.mkdirSync(claudeDir(), { recursive: true });
      fs.writeFileSync(path.join(claudeDir(), 'note.md'), 'mine');
      expect(claude().read(project, 'note.md')?.text).toBe('mine');
      fs.writeFileSync(path.join(outside, 'note.md'), 'ROOT ONLY');
      safeFsTest.beforeOpen = () => {
        fs.renameSync(claudeDir(), `${claudeDir()}.real`);
        fs.symlinkSync(outside, claudeDir());
        safeFsTest.beforeOpen = null;
      };
      expect(claude().read(project, 'note.md')).toBeNull();
    });

    it('as the agent (the box path): a file the agent cannot read is never mirrored', () => {
      safeFsTest.mode = { agentUid: process.getuid?.() ?? 0 } as never; // the agent-side read and list (privsep/agent-fs.ts)
      fs.mkdirSync(claudeDir(), { recursive: true });
      fs.writeFileSync(path.join(claudeDir(), 'open.md'), 'readable');
      fs.writeFileSync(path.join(claudeDir(), 'locked.md'), 'ROOT ONLY');
      fs.chmodSync(path.join(claudeDir(), 'locked.md'), 0o000);
      const db = new Database(':memory:');
      initSchema(db);
      sessionsDb.create(db, { id: 'A', provider: 'claude-code', name: 'a', workingDir: '/work/app' });
      const memory = new MemoryService({ db, projects: () => projectsFromDb(db), providers: buildProviders({ db, home, env: {}, projectDir: (w) => w }) });
      updateMemorySettings(db, { enabled: true });
      memory.syncProviders();
      const rows = store.listMirror(db, ['project:A']);
      expect(rows.map((r) => r.text)).toEqual(['readable']);
      expect(rows.some((r) => r.text.includes('ROOT ONLY'))).toBe(false);
      fs.chmodSync(path.join(claudeDir(), 'locked.md'), 0o600);
    });
  });
});
