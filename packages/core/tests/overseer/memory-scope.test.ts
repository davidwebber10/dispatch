// The Claude overseer's own memory folder (overseer memory scope spec 2026-10-07, Unit 1).
// Every test works in its own fs.mkdtempSync home and deletes only that folder.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  autoMemorySettingsArg,
  noteOriginSessionId,
  overseerMemoryDir,
  prepareOverseerMemory,
  sharedProjectMemoryDir,
} from '../../src/overseer/memory-scope.js';

const PROJECT = '/Users/someone/Developer/Projects/app';
const OVERSEER = '11111111-1111-4111-8111-111111111111';
const OLD_OVERSEER = '22222222-2222-4222-8222-222222222222';
const USER_THREAD = '33333333-3333-4333-8333-333333333333';

let home: string;
beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'overseer-memory-home-')); });
afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

const note = (origin: string | null, body: string) =>
  ['---', 'name: a note', 'description: one line', 'type: project', ...(origin ? [`originSessionId: ${origin}`] : []), '---', '', body, ''].join('\n');

function writeShared(files: Record<string, string>): string {
  const dir = sharedProjectMemoryDir(home, PROJECT);
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
  return dir;
}

describe('the memory folders', () => {
  it('own folder: <home>/.claude/dispatch-overseer/<encoded project dir>/memory', () => {
    expect(overseerMemoryDir(home, PROJECT)).toBe(path.join(home, '.claude', 'dispatch-overseer', '-Users-someone-Developer-Projects-app', 'memory'));
  });

  it("shared folder: Claude's own project folder, <home>/.claude/projects/<encoded project dir>/memory", () => {
    expect(sharedProjectMemoryDir(home, PROJECT)).toBe(path.join(home, '.claude', 'projects', '-Users-someone-Developer-Projects-app', 'memory'));
  });

  it('the --settings value is JSON that names the folder', () => {
    const dir = overseerMemoryDir(home, PROJECT);
    expect(JSON.parse(autoMemorySettingsArg(dir))).toEqual({ autoMemoryDirectory: dir });
  });
});

describe('noteOriginSessionId', () => {
  it('reads originSessionId from the frontmatter, quoted or not', () => {
    expect(noteOriginSessionId(note(OVERSEER, 'x'))).toBe(OVERSEER);
    expect(noteOriginSessionId(`---\noriginSessionId: "${OVERSEER}"\n---\nx`)).toBe(OVERSEER);
    expect(noteOriginSessionId(`---\r\noriginSessionId: '${OVERSEER}'\r\n---\r\nx`)).toBe(OVERSEER);
  });

  it('ignores a note without frontmatter, without the key, or with the key only in the body', () => {
    expect(noteOriginSessionId('no frontmatter at all')).toBeNull();
    expect(noteOriginSessionId(note(null, 'x'))).toBeNull();
    expect(noteOriginSessionId(note(null, `originSessionId: ${OVERSEER}`))).toBeNull();
  });
});

describe('prepareOverseerMemory', () => {
  const INDEX = [
    '# Memory index',
    '',
    '- [Overseer rule](overseer-rule.md) — from the overseer',
    '- [User fact](user-fact.md) — from a user thread',
    '- [Old overseer plan](old-plan.md) — from an archived overseer',
    '',
  ].join('\n');

  it('creates the folder when it is missing, with nothing to copy', () => {
    const out = prepareOverseerMemory({ home, projectDir: PROJECT, overseerSessionIds: [OVERSEER] });
    expect(fs.statSync(overseerMemoryDir(home, PROJECT)).isDirectory()).toBe(true);
    expect(out.copied).toEqual([]);
  });

  it("copies only the notes of this project's overseers, with their index lines; the shared files stay", () => {
    const shared = writeShared({
      'MEMORY.md': INDEX,
      'overseer-rule.md': note(OVERSEER, 'rule'),
      'user-fact.md': note(USER_THREAD, 'fact'),
      'old-plan.md': note(OLD_OVERSEER, 'plan'),
    });
    const before = fs.readdirSync(shared).sort();

    const out = prepareOverseerMemory({ home, projectDir: PROJECT, overseerSessionIds: [OVERSEER, OLD_OVERSEER] });

    const own = overseerMemoryDir(home, PROJECT);
    expect(out.copied.sort()).toEqual(['old-plan.md', 'overseer-rule.md']);
    expect(fs.readFileSync(path.join(own, 'overseer-rule.md'), 'utf8')).toBe(note(OVERSEER, 'rule'));
    expect(fs.readFileSync(path.join(own, 'old-plan.md'), 'utf8')).toBe(note(OLD_OVERSEER, 'plan'));
    expect(fs.existsSync(path.join(own, 'user-fact.md'))).toBe(false);
    expect(fs.readFileSync(path.join(own, 'MEMORY.md'), 'utf8')).toBe(
      '- [Overseer rule](overseer-rule.md) — from the overseer\n- [Old overseer plan](old-plan.md) — from an archived overseer\n',
    );
    // Nothing is deleted or changed in the shared folder.
    expect(fs.readdirSync(shared).sort()).toEqual(before);
    expect(fs.readFileSync(path.join(shared, 'MEMORY.md'), 'utf8')).toBe(INDEX);
  });

  it('a second start copies nothing, even when new overseer notes appear in the shared folder', () => {
    writeShared({ 'MEMORY.md': INDEX, 'overseer-rule.md': note(OVERSEER, 'rule') });
    prepareOverseerMemory({ home, projectDir: PROJECT, overseerSessionIds: [OVERSEER] });
    writeShared({ 'later.md': note(OVERSEER, 'a shared note written on purpose') });

    const out = prepareOverseerMemory({ home, projectDir: PROJECT, overseerSessionIds: [OVERSEER] });

    expect(out.copied).toEqual([]);
    expect(fs.existsSync(path.join(overseerMemoryDir(home, PROJECT), 'later.md'))).toBe(false);
  });

  it('a second start copies nothing also when the first start found no notes to copy', () => {
    prepareOverseerMemory({ home, projectDir: PROJECT, overseerSessionIds: [] });
    writeShared({ 'MEMORY.md': INDEX, 'overseer-rule.md': note(OVERSEER, 'rule') });
    expect(prepareOverseerMemory({ home, projectDir: PROJECT, overseerSessionIds: [OVERSEER] }).copied).toEqual([]);
  });

  it('copies nothing into a folder that already holds notes', () => {
    writeShared({ 'overseer-rule.md': note(OVERSEER, 'rule') });
    const own = overseerMemoryDir(home, PROJECT);
    fs.mkdirSync(own, { recursive: true });
    fs.writeFileSync(path.join(own, 'mine.md'), note(OVERSEER, 'mine'));
    expect(prepareOverseerMemory({ home, projectDir: PROJECT, overseerSessionIds: [OVERSEER] }).copied).toEqual([]);
    expect(fs.readdirSync(own)).toEqual(['mine.md']);
  });

  it('skips symlinks, subfolders and files that are not notes', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'overseer-memory-outside-'));
    try {
      fs.writeFileSync(path.join(outside, 'secret.md'), note(OVERSEER, 'outside'));
      const shared = writeShared({ 'notes.txt': note(OVERSEER, 'text'), 'ok.md': note(OVERSEER, 'ok') });
      fs.symlinkSync(path.join(outside, 'secret.md'), path.join(shared, 'linked.md'));
      fs.mkdirSync(path.join(shared, 'sub.md'));
      const out = prepareOverseerMemory({ home, projectDir: PROJECT, overseerSessionIds: [OVERSEER] });
      expect(out.copied).toEqual(['ok.md']);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('writes no MEMORY.md when no index line names a copied note', () => {
    writeShared({ 'overseer-rule.md': note(OVERSEER, 'rule') });
    prepareOverseerMemory({ home, projectDir: PROJECT, overseerSessionIds: [OVERSEER] });
    expect(fs.existsSync(path.join(overseerMemoryDir(home, PROJECT), 'MEMORY.md'))).toBe(false);
    expect(fs.existsSync(path.join(overseerMemoryDir(home, PROJECT), 'overseer-rule.md'))).toBe(true);
  });
});
