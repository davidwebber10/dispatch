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
  COPY_CURSOR,
  COPY_LIMITS,
  COPY_MARKER,
  gitRoots,
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

  function makeRepo(name = 'repo'): string {
    const repo = path.join(tmp, name);
    fs.mkdirSync(path.join(repo, 'packages', 'core'), { recursive: true });
    git(repo, 'init', '-q');
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'init');
    return repo;
  }

  /** The folder the shared memory follows, or null when the resolution failed. */
  const keyOf = (dir: string) => claudeMemoryProjectDir(dir).dir;

  it('the main root, a subfolder and a worktree all give the main root', () => {
    const repo = makeRepo();
    const wt = path.join(tmp, 'wt');
    git(repo, 'worktree', 'add', '-q', '-b', 'side', wt);
    fs.mkdirSync(path.join(wt, 'sub'));
    expect(keyOf(repo)).toBe(repo);
    expect(keyOf(path.join(repo, 'packages', 'core'))).toBe(repo);
    expect(keyOf(wt)).toBe(repo);
    expect(keyOf(path.join(wt, 'sub'))).toBe(repo);
  });

  it('a folder outside a git repository gives itself', () => {
    const plain = path.join(tmp, 'plain');
    fs.mkdirSync(plain);
    expect(claudeMemoryProjectDir(plain)).toEqual({ dir: plain });
  });

  it('a symlinked path gives the canonical path', () => {
    const repo = makeRepo();
    const plain = path.join(tmp, 'plain');
    fs.mkdirSync(plain);
    fs.symlinkSync(repo, path.join(tmp, 'repo-link'));
    fs.symlinkSync(plain, path.join(tmp, 'plain-link'));
    expect(keyOf(path.join(tmp, 'repo-link', 'packages'))).toBe(repo);
    expect(keyOf(path.join(tmp, 'plain-link'))).toBe(plain);
  });

  // Review round 2, fix 1: a git failure is not "outside git".
  describe('gitRoots: three results', () => {
    it('inside a repository: the common dir and the top level', () => {
      const repo = makeRepo();
      expect(gitRoots(path.join(repo, 'packages'))).toEqual({ kind: 'repo', commonDir: path.join(repo, '.git'), topLevel: repo });
    });

    it('not a repository: only when git says so', () => {
      const plain = path.join(tmp, 'plain');
      fs.mkdirSync(plain);
      expect(gitRoots(plain)).toEqual({ kind: 'none' });
    });

    it('resolution failed: a folder that does not exist, and a bare repository', () => {
      const missing = gitRoots(path.join(tmp, 'missing'));
      expect(missing.kind).toBe('failed');
      git(tmp, 'init', '-q', '--bare', 'bare.git');
      const bare = gitRoots(path.join(tmp, 'bare.git'));
      expect(bare.kind).toBe('failed');
      expect(bare.kind === 'failed' && bare.reason).toContain('work tree');
    });

    // chmod 000 does not stop root.
    it.skipIf(process.getuid?.() === 0)('resolution failed: an unreadable folder', () => {
      const locked = path.join(tmp, 'locked');
      fs.mkdirSync(locked);
      fs.chmodSync(locked, 0o000);
      try {
        expect(gitRoots(locked).kind).toBe('failed');
      } finally {
        fs.chmodSync(locked, 0o755);
      }
    });

    it('claudeMemoryProjectDir: a failed resolution gives no folder, with the reason', () => {
      expect(claudeMemoryProjectDir(tmp, () => ({ kind: 'failed', reason: 'ETIMEDOUT' }))).toEqual({ dir: null, reason: 'ETIMEDOUT' });
      expect(claudeMemoryProjectDir(path.join(tmp, 'missing')).dir).toBeNull();
    });
  });

  // Review round 2, fix 2: a common dir not named .git is not guessed; path bytes stay exact.
  describe('unusual layouts and exact paths', () => {
    it('a separate git dir defers, in the main checkout and in a worktree of it', () => {
      git(tmp, 'init', '-q', `--separate-git-dir=${path.join(tmp, 'gitdir')}`, 'sep');
      const sep = path.join(tmp, 'sep');
      git(sep, 'commit', '-q', '--allow-empty', '-m', 'init');
      const wt = path.join(tmp, 'sep-wt');
      git(sep, 'worktree', 'add', '-q', '-b', 'side', wt);
      for (const dir of [sep, wt]) {
        const out = claudeMemoryProjectDir(dir);
        expect(out.dir, dir).toBeNull();
        expect(out.reason).toContain(path.join(tmp, 'gitdir'));
      }
    });

    it('a bare repository and a submodule-like common dir defer', () => {
      git(tmp, 'init', '-q', '--bare', 'bare.git');
      expect(keyOf(path.join(tmp, 'bare.git'))).toBeNull();
      expect(keyOf(tmp)).not.toBeNull(); // the temporary folder itself is outside git
      expect(claudeMemoryProjectDir(tmp, () => ({ kind: 'repo', commonDir: path.join(tmp, '.git', 'modules', 'sub'), topLevel: tmp })).dir).toBeNull();
    });

    it('a path with a trailing space survives', () => {
      const repo = makeRepo('repo ');
      expect(gitRoots(path.join(repo, 'packages'))).toEqual({ kind: 'repo', commonDir: path.join(repo, '.git'), topLevel: repo });
      expect(keyOf(path.join(repo, 'packages', 'core'))).toBe(repo);
    });
  });
});

describe('noteOriginSessionId', () => {
  it('reads originSessionId from the frontmatter, quoted or not', () => {
    expect(noteOriginSessionId(note(OVERSEER, 'x'))).toBe(OVERSEER);
    expect(noteOriginSessionId(`---\noriginSessionId: "${OVERSEER}"\n---\nx`)).toBe(OVERSEER);
    expect(noteOriginSessionId(`---\r\noriginSessionId: '${OVERSEER}'\r\n---\r\nx`)).toBe(OVERSEER);
  });

  // Claude Code writes the key nested under `metadata:`, indented by two spaces. /verify found
  // that the parser missed this real shape, so the copy found no overseer note and sealed itself.
  it('reads originSessionId nested under metadata, as Claude Code writes it', () => {
    const real = [
      '---',
      'name: some-note',
      'description: "a one-line summary"',
      'metadata:',
      '  node_type: memory',
      '  type: feedback',
      `  originSessionId: ${OVERSEER}`,
      '  modified: 2026-10-07T12:00:00.000Z',
      '---',
      '',
      'The note body.',
    ].join('\n');
    expect(noteOriginSessionId(real)).toBe(OVERSEER);
    expect(noteOriginSessionId(real.replace(`  originSessionId: ${OVERSEER}`, `    originSessionId: "${OVERSEER}"`))).toBe(OVERSEER);
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

  // Review round 2, fix 1: when the repository could not be resolved, the copy waits.
  it('no shared folder (the resolution failed): the own folder is set up, nothing is copied, no marker; the next start copies', () => {
    writeShared({ 'overseer-rule.md': note(OVERSEER, 'rule') });
    const first = prepareOverseerMemory({ home, projectDir: PROJECT, sharedProjectDir: null, overseerSessionIds: [OVERSEER] });
    expect(first).toEqual({ dir: own(), copied: [], done: false });
    expect(fs.readdirSync(own())).toEqual([]);
    expect(prepare([OVERSEER])).toEqual({ dir: own(), copied: ['overseer-rule.md'], done: true });
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

    // Review round 2, fix 3: the cursor is exact and checked against the shared folder.
    const writeCursor = (text: string) => {
      fs.mkdirSync(own(), { recursive: true });
      fs.writeFileSync(path.join(own(), COPY_CURSOR), text);
    };
    const memoryLines = (spy: ReturnType<typeof vi.spyOn>) => spy.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith('[overseer-memory]'));

    it('a cursor that names no note of the shared folder is ignored: the copy starts at the beginning, logged once', () => {
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      writeShared({ 'a.md': note(OVERSEER, 'a') });
      writeCursor('zzzz\n');

      expect(prepare([OVERSEER])).toEqual({ dir: own(), copied: ['a.md'], done: true });

      expect(memoryLines(err)).toHaveLength(1);
      expect(fs.existsSync(path.join(own(), COPY_CURSOR))).toBe(false);
    });

    it('the cursor is read as it is: a note name with a leading space is not skipped', () => {
      writeShared({ ' a.md': note(OVERSEER, 'a'), ' b.md': note(OVERSEER, 'b'), 'c.md': note(OVERSEER, 'c') });
      writeCursor(' a.md\n'); // the first start handled ' a.md'

      expect(prepare([OVERSEER])).toEqual({ dir: own(), copied: [' b.md', 'c.md'], done: true });
    });

    it('a folder at the cursor path: no crash, the notes are copied, and the copy is not marked done', () => {
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      writeShared({ 'a.md': note(OVERSEER, 'a') });
      fs.mkdirSync(path.join(own(), COPY_CURSOR), { recursive: true });

      expect(prepare([OVERSEER])).toEqual({ dir: own(), copied: ['a.md'], done: false });

      expect(fs.existsSync(path.join(own(), COPY_MARKER))).toBe(false);
      expect(memoryLines(err)).toHaveLength(1);
      expect(memoryLines(err)[0]).toContain(COPY_CURSOR);
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

    // Review round 2, fix 5: less work on the start path.
    it(`copies at most ${COPY_LIMITS.maxCopyBytes} note bytes per start; the next start goes on after them`, () => {
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      const size = 1_000_000; // under the 1 MB note bound
      const count = Math.floor(COPY_LIMITS.maxCopyBytes / size) + 1;
      const files: Record<string, string> = {};
      for (let i = 0; i < count; i++) {
        const head = note(OVERSEER, '');
        files[`big-${String(i).padStart(2, '0')}.md`] = head + 'x'.repeat(size - head.length);
      }
      writeShared(files);

      const first = prepare([OVERSEER]);
      expect(first.done).toBe(false);
      expect(first.copied.length).toBe(count - 1);
      const copiedBytes = first.copied.reduce((n, name) => n + fs.statSync(path.join(own(), name)).size, 0);
      expect(copiedBytes).toBeLessThanOrEqual(COPY_LIMITS.maxCopyBytes);
      expect(err).toHaveBeenCalledTimes(1);

      const last = `big-${String(count - 1).padStart(2, '0')}.md`;
      expect(prepare([OVERSEER])).toEqual({ dir: own(), copied: [last], done: true });
    });

    it(`does not read a destination MEMORY.md over ${COPY_LIMITS.maxIndexBytes} bytes: it stays as it is, logged`, () => {
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      writeShared({ 'MEMORY.md': '- [Rule](overseer-rule.md)\n', 'overseer-rule.md': note(OVERSEER, 'rule') });
      fs.mkdirSync(own(), { recursive: true });
      const big = '- [Mine](mine.md) — a line of my own index\n'.repeat(Math.ceil(COPY_LIMITS.maxIndexBytes / 40) + 1);
      expect(big.length).toBeGreaterThan(COPY_LIMITS.maxIndexBytes);
      fs.writeFileSync(path.join(own(), 'MEMORY.md'), big);

      expect(prepare([OVERSEER])).toEqual({ dir: own(), copied: ['overseer-rule.md'], done: true });

      expect(fs.readFileSync(path.join(own(), 'MEMORY.md'), 'utf8')).toBe(big);
      expect(err).toHaveBeenCalledTimes(1);
      expect(String(err.mock.calls[0][0])).toContain(path.join(own(), 'MEMORY.md'));
    });

    it(`does not read a shared MEMORY.md over ${COPY_LIMITS.maxIndexBytes} bytes: no index lines, logged`, () => {
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      const index = '- [Rule](overseer-rule.md)\n' + '- [Other](other.md)\n'.repeat(Math.ceil(COPY_LIMITS.maxIndexBytes / 20) + 1);
      expect(index.length).toBeGreaterThan(COPY_LIMITS.maxIndexBytes);
      expect(index.length).toBeLessThan(COPY_LIMITS.maxNoteBytes);
      writeShared({ 'MEMORY.md': index, 'overseer-rule.md': note(OVERSEER, 'rule') });

      expect(prepare([OVERSEER])).toEqual({ dir: own(), copied: ['overseer-rule.md'], done: true });

      expect(fs.existsSync(path.join(own(), 'MEMORY.md'))).toBe(false);
      expect(err).toHaveBeenCalledTimes(1);
      expect(String(err.mock.calls[0][0])).toContain('MEMORY.md');
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
      fs.mkdirSync(path.join(outside, 'claude', 'dispatch-overseer'), { recursive: true });
      fs.mkdirSync(path.join(outside, 'claude', 'projects'));
      fs.symlinkSync(path.join(outside, 'claude'), path.join(home, '.claude'));
      writeShared({ 'overseer-rule.md': note(OVERSEER, 'rule') });
      expect(ownMemoryFolderSafe(home, own())).toBe(true);
      expect(sharedMemoryFolderSafe(home, sharedProjectMemoryDir(home, PROJECT))).toBe(true);
      expect(prepare([OVERSEER])).toEqual({ dir: own(), copied: ['overseer-rule.md'], done: true });
    });

    // Review round 2, fix 4: the roots themselves are not trusted; the anchor is the canonical ~/.claude.
    it('a symlinked dispatch-overseer root is refused: no setup and no copy; nothing is written outside', () => {
      writeShared({ 'overseer-rule.md': note(OVERSEER, 'rule') });
      fs.symlinkSync(outside, path.join(home, '.claude', 'dispatch-overseer'));
      expect(ownMemoryFolderSafe(home, own())).toBe(false);
      expect(prepare([OVERSEER])).toEqual({ dir: null, copied: [], done: false });
      expect(fs.readdirSync(outside)).toEqual([]);
    });

    it('a symlinked projects root is refused: the own folder is set up and nothing is copied', () => {
      const planted = path.join(outside, path.relative(path.join(home, '.claude', 'projects'), sharedProjectMemoryDir(home, PROJECT)));
      fs.mkdirSync(planted, { recursive: true });
      fs.writeFileSync(path.join(planted, 'planted.md'), note(OVERSEER, 'planted'));
      fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
      fs.symlinkSync(outside, path.join(home, '.claude', 'projects'));
      expect(sharedMemoryFolderSafe(home, sharedProjectMemoryDir(home, PROJECT))).toBe(false);
      expect(prepare([OVERSEER])).toEqual({ dir: own(), copied: [], done: false });
      expect(fs.readdirSync(own())).toEqual([]);
    });
  });
});
