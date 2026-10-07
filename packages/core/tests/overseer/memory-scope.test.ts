// The Claude overseer's own memory folder (overseer memory scope spec 2026-10-07, Unit 1).
// Every test works in its own fs.mkdtempSync home and deletes only that folder.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  autoMemorySettingsArg,
  claudeMemoryProjectDir,
  COPY_LIMITS,
  COPY_MARKER,
  noteOriginSessionId,
  overseerMemoryDir,
  ownMemoryFolderSafe,
  prepareOverseerMemory,
  sharedMemoryFolderSafe,
  sharedProjectMemoryDir,
} from '../../src/overseer/memory-scope.js';

const PROJECT = '/Users/someone/Developer/Projects/app';
const OVERSEER = '11111111-1111-4111-8111-111111111111';
const OLD_OVERSEER = '22222222-2222-4222-8222-222222222222';
const USER_THREAD = '33333333-3333-4333-8333-333333333333';

let home: string;
beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'overseer-memory-home-')); });
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(home, { recursive: true, force: true });
});

const note = (origin: string | null, body: string) =>
  ['---', 'name: a note', 'description: one line', 'type: project', ...(origin ? [`originSessionId: ${origin}`] : []), '---', '', body, ''].join('\n');

function writeShared(files: Record<string, string>): string {
  const dir = sharedProjectMemoryDir(home, PROJECT);
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
  return dir;
}

/** One overseer start's copy, for PROJECT (outside a git repository, so both folders key on it). */
const prepare = (ids: readonly string[]) => prepareOverseerMemory({ home, projectDir: PROJECT, sharedProjectDir: PROJECT, overseerSessionIds: ids });
const own = () => overseerMemoryDir(home, PROJECT);
const ownNotes = () => fs.readdirSync(own()).filter((n) => n.endsWith('.md')).sort();

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

// Review round 1, fix 1: Claude keys the shared memory by the git repository ("all worktrees and
// subdirectories within the same repo share one auto memory directory"). Real git repositories in
// a temporary folder; git runs with no user config (HOME is the private test home).
describe('claudeMemoryProjectDir — the folder the shared memory follows', () => {
  let tmp: string;
  const git = (cwd: string, ...args: string[]) => {
    const env = { ...process.env };
    for (const k of Object.keys(env)) if (k.startsWith('GIT_')) delete env[k];
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', ...args], { cwd, env, stdio: 'ignore' });
  };
  beforeEach(() => { tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'overseer-memory-git-'))); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  function makeRepo(): string {
    const repo = path.join(tmp, 'repo');
    fs.mkdirSync(path.join(repo, 'packages', 'core'), { recursive: true });
    git(repo, 'init', '-q');
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'init');
    return repo;
  }

  it('the main root, a subfolder and a worktree all give the main root', () => {
    const repo = makeRepo();
    const wt = path.join(tmp, 'wt');
    git(repo, 'worktree', 'add', '-q', '-b', 'side', wt);
    fs.mkdirSync(path.join(wt, 'sub'));
    expect(claudeMemoryProjectDir(repo)).toBe(repo);
    expect(claudeMemoryProjectDir(path.join(repo, 'packages', 'core'))).toBe(repo);
    expect(claudeMemoryProjectDir(wt)).toBe(repo);
    expect(claudeMemoryProjectDir(path.join(wt, 'sub'))).toBe(repo);
  });

  it('a folder outside a git repository gives itself', () => {
    const plain = path.join(tmp, 'plain');
    fs.mkdirSync(plain);
    expect(claudeMemoryProjectDir(plain)).toBe(plain);
  });

  it('a symlinked path gives the canonical path', () => {
    const repo = makeRepo();
    const plain = path.join(tmp, 'plain');
    fs.mkdirSync(plain);
    fs.symlinkSync(repo, path.join(tmp, 'repo-link'));
    fs.symlinkSync(plain, path.join(tmp, 'plain-link'));
    expect(claudeMemoryProjectDir(path.join(tmp, 'repo-link', 'packages'))).toBe(repo);
    expect(claudeMemoryProjectDir(path.join(tmp, 'plain-link'))).toBe(plain);
  });

  it('a folder that does not exist gives itself; a common dir not named .git gives the top level', () => {
    expect(claudeMemoryProjectDir(PROJECT)).toBe(PROJECT);
    expect(claudeMemoryProjectDir(tmp, () => ({ commonDir: path.join(tmp, '.git', 'modules', 'sub'), topLevel: tmp }))).toBe(tmp);
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
    const out = prepare([OVERSEER]);
    expect(fs.statSync(own()).isDirectory()).toBe(true);
    expect(out).toEqual({ dir: own(), copied: [], done: true });
  });

  it("copies only the notes of this project's overseers, with their index lines; the shared files stay", () => {
    const shared = writeShared({
      'MEMORY.md': INDEX,
      'overseer-rule.md': note(OVERSEER, 'rule'),
      'user-fact.md': note(USER_THREAD, 'fact'),
      'old-plan.md': note(OLD_OVERSEER, 'plan'),
    });
    const before = fs.readdirSync(shared).sort();

    const out = prepare([OVERSEER, OLD_OVERSEER]);

    expect(out.copied.sort()).toEqual(['old-plan.md', 'overseer-rule.md']);
    expect(fs.readFileSync(path.join(own(), 'overseer-rule.md'), 'utf8')).toBe(note(OVERSEER, 'rule'));
    expect(fs.readFileSync(path.join(own(), 'old-plan.md'), 'utf8')).toBe(note(OLD_OVERSEER, 'plan'));
    expect(fs.existsSync(path.join(own(), 'user-fact.md'))).toBe(false);
    expect(fs.readFileSync(path.join(own(), 'MEMORY.md'), 'utf8')).toBe(
      '- [Overseer rule](overseer-rule.md) — from the overseer\n- [Old overseer plan](old-plan.md) — from an archived overseer\n',
    );
    // Nothing is deleted or changed in the shared folder.
    expect(fs.readdirSync(shared).sort()).toEqual(before);
    expect(fs.readFileSync(path.join(shared, 'MEMORY.md'), 'utf8')).toBe(INDEX);
  });

  // Review round 1, fix 7.
  it('copies the index lines of the (./name.md) form too', () => {
    writeShared({
      'MEMORY.md': '- [Rule](./overseer-rule.md) — dot form\n- [Fact](./user-fact.md) — not mine\n',
      'overseer-rule.md': note(OVERSEER, 'rule'),
      'user-fact.md': note(USER_THREAD, 'fact'),
    });
    prepare([OVERSEER]);
    expect(fs.readFileSync(path.join(own(), 'MEMORY.md'), 'utf8')).toBe('- [Rule](./overseer-rule.md) — dot form\n');
  });

  it('a second start copies nothing, even when new overseer notes appear in the shared folder', () => {
    writeShared({ 'MEMORY.md': INDEX, 'overseer-rule.md': note(OVERSEER, 'rule') });
    prepare([OVERSEER]);
    writeShared({ 'later.md': note(OVERSEER, 'a shared note written on purpose') });

    const out = prepare([OVERSEER]);

    expect(out).toEqual({ dir: own(), copied: [], done: true });
    expect(fs.existsSync(path.join(own(), 'later.md'))).toBe(false);
  });

  it('a second start copies nothing also when the first start found no notes to copy', () => {
    prepare([]);
    writeShared({ 'MEMORY.md': INDEX, 'overseer-rule.md': note(OVERSEER, 'rule') });
    expect(prepare([OVERSEER]).copied).toEqual([]);
  });

  it('skips symlinks, subfolders and files that are not notes', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'overseer-memory-outside-'));
    try {
      fs.writeFileSync(path.join(outside, 'secret.md'), note(OVERSEER, 'outside'));
      const shared = writeShared({ 'notes.txt': note(OVERSEER, 'text'), 'ok.md': note(OVERSEER, 'ok') });
      fs.symlinkSync(path.join(outside, 'secret.md'), path.join(shared, 'linked.md'));
      fs.mkdirSync(path.join(shared, 'sub.md'));
      const out = prepare([OVERSEER]);
      expect(out.copied).toEqual(['ok.md']);
      expect(out.done).toBe(true);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('writes no MEMORY.md when no index line names a copied note', () => {
    writeShared({ 'overseer-rule.md': note(OVERSEER, 'rule') });
    prepare([OVERSEER]);
    expect(fs.existsSync(path.join(own(), 'MEMORY.md'))).toBe(false);
    expect(fs.existsSync(path.join(own(), 'overseer-rule.md'))).toBe(true);
  });

  // Review round 1, fix 3: the copy can resume; the marker comes only after a clean pass.
  describe('resume', () => {
    // chmod 000 does not stop root, so the read error cannot happen there.
    it.skipIf(process.getuid?.() === 0)('a read error in the middle leaves no marker; the next start copies the rest, each note and index line once', () => {
      const shared = writeShared({
        'MEMORY.md': '- [A](a.md)\n- [B](b.md)\n- [C](c.md)\n- [U](u.md)\n',
        'a.md': note(OVERSEER, 'a'),
        'b.md': note(OVERSEER, 'b'),
        'c.md': note(OLD_OVERSEER, 'c'),
        'u.md': note(USER_THREAD, 'u'),
      });
      fs.chmodSync(path.join(shared, 'b.md'), 0o000);

      const first = prepare([OVERSEER, OLD_OVERSEER]);
      expect(first).toEqual({ dir: own(), copied: ['a.md', 'c.md'], done: false });
      expect(fs.existsSync(path.join(own(), COPY_MARKER))).toBe(false);

      fs.chmodSync(path.join(shared, 'b.md'), 0o644);
      const second = prepare([OVERSEER, OLD_OVERSEER]);
      expect(second).toEqual({ dir: own(), copied: ['b.md'], done: true });
      expect(ownNotes()).toEqual(['MEMORY.md', 'a.md', 'b.md', 'c.md']);
      expect(fs.readFileSync(path.join(own(), 'b.md'), 'utf8')).toBe(note(OVERSEER, 'b'));
      expect(fs.readFileSync(path.join(own(), 'MEMORY.md'), 'utf8').split('\n').filter(Boolean).sort()).toEqual(['- [A](a.md)', '- [B](b.md)', '- [C](c.md)']);
      expect(fs.existsSync(path.join(own(), COPY_MARKER))).toBe(true);
    });

    it('never overwrites a note that is already in the folder, and keeps its index', () => {
      writeShared({ 'MEMORY.md': '- [Rule](overseer-rule.md)\n- [Plan](old-plan.md)\n', 'overseer-rule.md': note(OVERSEER, 'shared copy'), 'old-plan.md': note(OVERSEER, 'plan') });
      fs.mkdirSync(own(), { recursive: true });
      fs.writeFileSync(path.join(own(), 'overseer-rule.md'), 'my own edit');
      fs.writeFileSync(path.join(own(), 'MEMORY.md'), '- [Rule](overseer-rule.md)');

      const out = prepare([OVERSEER]);

      expect(out).toEqual({ dir: own(), copied: ['old-plan.md'], done: true });
      expect(fs.readFileSync(path.join(own(), 'overseer-rule.md'), 'utf8')).toBe('my own edit');
      expect(fs.readFileSync(path.join(own(), 'MEMORY.md'), 'utf8')).toBe('- [Rule](overseer-rule.md)\n- [Plan](old-plan.md)\n');
    });
  });

  // Review round 1, fix 4: the copy is bounded.
  describe('bounds', () => {
    it(`reads at most the first ${COPY_LIMITS.headBytes} bytes of a note to find its origin, and copies a matching note whole`, () => {
      const pad = 'x'.repeat(COPY_LIMITS.headBytes);
      const late = `---\ndescription: ${pad}\noriginSessionId: ${OVERSEER}\n---\nbody\n`;
      const big = note(OVERSEER, 'y'.repeat(3 * COPY_LIMITS.headBytes));
      writeShared({ 'late.md': late, 'big.md': big });
      const read = vi.spyOn(fs, 'readSync');

      const out = prepare([OVERSEER]);
      const pastHead = read.mock.calls.filter(([, , , len]) => (len as number) > COPY_LIMITS.headBytes).length;
      read.mockRestore();

      expect(out.copied).toEqual(['big.md']); // late.md names the overseer only after the first 8 KB
      expect(pastHead).toBe(1); // only big.md, a match, was read past its head
      expect(fs.readFileSync(path.join(own(), 'big.md'), 'utf8')).toBe(big);
    });

    it('skips a note over 1 MB and logs once for all of them; the copy still ends', () => {
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      const huge = note(OVERSEER, 'z'.repeat(COPY_LIMITS.maxNoteBytes));
      writeShared({ 'huge-1.md': huge, 'huge-2.md': huge, 'ok.md': note(OVERSEER, 'ok') });

      expect(prepare([OVERSEER])).toEqual({ dir: own(), copied: ['ok.md'], done: true });

      expect(err).toHaveBeenCalledTimes(1);
      expect(String(err.mock.calls[0][0])).toContain('huge-1.md, huge-2.md');
    });

    it(`handles at most ${COPY_LIMITS.maxNotes} notes per start; the next start goes on after them`, () => {
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      const files: Record<string, string> = {};
      const count = COPY_LIMITS.maxNotes + 2;
      for (let i = 0; i < count; i++) files[`n${String(i).padStart(4, '0')}.md`] = note(i % 2 ? OVERSEER : USER_THREAD, `${i}`);
      writeShared(files);

      const first = prepare([OVERSEER]);
      expect(first.done).toBe(false);
      expect(first.copied.length).toBe(COPY_LIMITS.maxNotes / 2);
      expect(err).toHaveBeenCalledTimes(1);

      const second = prepare([OVERSEER]);
      expect(second).toEqual({ dir: own(), copied: ['n0501.md'], done: true });
      expect(ownNotes().length).toBe(count / 2);
    });
  });

  // Review round 1, fix 2: a symlink must not lead the setup or the copy out of the memory roots.
  describe('symlinked folders', () => {
    let outside: string;
    beforeEach(() => { outside = fs.mkdtempSync(path.join(os.tmpdir(), 'overseer-memory-outside-')); });
    afterEach(() => { fs.rmSync(outside, { recursive: true, force: true }); });

    it('a symlinked own folder: no setup and no copy; nothing is written outside', () => {
      writeShared({ 'overseer-rule.md': note(OVERSEER, 'rule') });
      fs.mkdirSync(path.dirname(own()), { recursive: true });
      fs.symlinkSync(outside, own());
      expect(ownMemoryFolderSafe(home, own())).toBe(false);
      expect(prepare([OVERSEER])).toEqual({ dir: null, copied: [], done: false });
      expect(fs.readdirSync(outside)).toEqual([]);
    });

    it('a symlinked ancestor below the root: no setup and no copy', () => {
      writeShared({ 'overseer-rule.md': note(OVERSEER, 'rule') });
      fs.mkdirSync(path.join(home, '.claude', 'dispatch-overseer'), { recursive: true });
      fs.symlinkSync(outside, path.dirname(own())); // <root>/<encoded project dir> → outside
      expect(ownMemoryFolderSafe(home, own())).toBe(false);
      expect(prepare([OVERSEER])).toEqual({ dir: null, copied: [], done: false });
      expect(fs.readdirSync(outside)).toEqual([]);
    });

    it('a symlinked shared folder: the own folder is set up, nothing is copied, and no marker is written', () => {
      const shared = sharedProjectMemoryDir(home, PROJECT);
      fs.writeFileSync(path.join(outside, 'planted.md'), note(OVERSEER, 'planted'));
      fs.mkdirSync(path.dirname(shared), { recursive: true });
      fs.symlinkSync(outside, shared);
      expect(sharedMemoryFolderSafe(home, shared)).toBe(false);

      expect(prepare([OVERSEER])).toEqual({ dir: own(), copied: [], done: false });
      expect(fs.readdirSync(own())).toEqual([]);
    });

    it('a symlinked ~/.claude is followed: both folders stay inside its real target', () => {
      fs.rmSync(home, { recursive: true, force: true });
      fs.mkdirSync(home);
      fs.mkdirSync(path.join(outside, 'claude'));
      fs.symlinkSync(path.join(outside, 'claude'), path.join(home, '.claude'));
      writeShared({ 'overseer-rule.md': note(OVERSEER, 'rule') });
      expect(ownMemoryFolderSafe(home, own())).toBe(true);
      expect(sharedMemoryFolderSafe(home, sharedProjectMemoryDir(home, PROJECT))).toBe(true);
      expect(prepare([OVERSEER])).toEqual({ dir: own(), copied: ['overseer-rule.md'], done: true });
    });
  });
});
