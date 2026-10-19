/**
 * The in-progress docs of a project (chat thread visibility spec, 12.7; decision CTV-DOCS). Read only.
 *
 * - Only `.md` docs in DOC_FOLDERS that are not on main, or that differ from main. A copy that
 *   matches main, or a doc that exists only on main, is never listed. The main checkout adds no rows.
 * - Copies come from each worktree in the project folder (committed and uncommitted changes and
 *   untracked files in those folders, against the default branch) and from each unmerged branch
 *   with no worktree (`git diff --name-only default...branch`), the newest DOCS_BRANCHES branches.
 * - One row per path: the newest copy, with the number of copies. At most DOCS_ROWS rows, newest
 *   first, and the total.
 * - Every ref passed to git comes from `refs()` / `defaultBranch()`. A file over DOC_MAX_BYTES is
 *   not read (and not listed).
 * - A worktree copy is read only through its real path, which must stay inside the project folder
 *   and be a regular `.md` file (a symlink that leads out is never read), with `readConfined`.
 * - The main checkout's own branch counts as checked out. A remote-tracking branch whose local
 *   branch exists is the same copy, so it is counted once.
 * - Git runs only through the async helpers (`execFile`, no shell), so a list never blocks the
 *   daemon's event loop.
 */
import fs from 'node:fs';
import path from 'node:path';
import { locate, projectWorktreesAsync } from '../overseer/source-file.js';
import { isRepoAsync, refsAsync, defaultBranchAsync, blobHashAsync, blobSizeAsync, readBlobAsync, hashBytes, commitDateAsync, gitAsync, DOCS_BRANCHES } from './git.js';
import { statusLine, DOC_MAX_BYTES } from './resolve.js';
import { readConfined } from './confined.js';

export const DOC_FOLDERS = ['docs/superpowers/specs', 'docs/superpowers/plans', 'docs/specs', 'docs/plans'];
export const DOCS_ROWS = 5;
export { DOCS_BRANCHES };
export const DOCS_CACHE_MS = 60_000;
/** `worktree`: the base name (what the chip shows); `worktreeRel`: its path in the project (what names it). */
export interface DocRow { path: string; name: string; status: string | null; source: 'worktree' | 'branch'; worktree: string | null; worktreeRel: string | null; branch: string | null; vsMain: 'changed' | 'not_on_main'; modifiedAt: string; copies: number; writer: { id: string; label: string } | null }
export type DocWriterOf = (c: { path: string; worktreeReal: string | null }) => { id: string; label: string } | null;
export type DocLister = (project: { id: string; folder: string }, writerOf: DocWriterOf) => Promise<{ rows: DocRow[]; total: number }>;

const lines = (s: string | null) => (s ?? '').split('\n').map((x) => x.trim()).filter(Boolean);
/** `-z` output: NUL-separated, never quoted (a name with spaces or non-ASCII stays as it is). */
const names = (s: string | null) => (s ?? '').split('\0').filter(Boolean);
const isDoc = (p: string) => /\.md$/i.test(p) && DOC_FOLDERS.some((f) => p.startsWith(`${f}/`));
const NONE = () => ({ rows: [] as DocRow[], total: 0 });

export const listDocs: DocLister = async (project, writerOf) => {
  let realRoot: string;
  try { realRoot = fs.realpathSync.native(project.folder); } catch { return NONE(); }
  if (!(await isRepoAsync(realRoot))) return NONE();
  const base = await defaultBranchAsync(realRoot);
  if (!base) return NONE();
  type Copy = Omit<DocRow, 'copies' | 'writer' | 'name'> & { at: number; worktreeReal: string | null };
  const copies: Copy[] = [];
  const vs = async (rel: string, bytes: Buffer): Promise<DocRow['vsMain'] | null> => {
    const h = await blobHashAsync(realRoot, base, rel);
    return h === null ? 'not_on_main' : h === hashBytes(bytes) ? null : 'changed';
  };

  // 1. Worktrees. A folder under .worktrees that is not a worktree of its own would run git in
  //    the main checkout, so only a folder that is its own work tree top counts.
  const wts: Awaited<ReturnType<typeof projectWorktreesAsync>> = [];
  for (const w of await projectWorktreesAsync(realRoot)) if (await isRepoAsync(w.real)) wts.push(w);
  for (const w of wts) {
    const [changed, untracked] = await Promise.all([
      gitAsync(w.real, ['diff', '-z', '--name-only', base, '--', ...DOC_FOLDERS]),
      gitAsync(w.real, ['ls-files', '-z', '--others', '--exclude-standard', '--', ...DOC_FOLDERS]),
    ]);
    for (const rel of new Set([...names(changed), ...names(untracked)])) {
      if (!isDoc(rel)) continue;
      // The real path must stay inside the project and be a regular .md file.
      const real = locate(realRoot, path.join(w.rel, rel));
      if (real === 'missing' || real === 'outside' || !/\.md$/i.test(real)) continue; // deleted, or leads out
      const file = await readConfined(realRoot, real, DOC_MAX_BYTES);
      if (file.kind !== 'file') continue; // not a regular file, too large, or changed since the check
      const { bytes, mtime } = file;
      const v = await vs(rel, bytes);
      if (!v) continue;
      copies.push({ path: rel, status: statusLine(bytes.toString('utf8')), source: 'worktree', worktree: w.name, worktreeRel: w.rel.split(path.sep).join('/'), branch: w.branch, vsMain: v, modifiedAt: mtime.toISOString(), at: mtime.getTime(), worktreeReal: w.real });
    }
  }

  // 2. Unmerged branches with no worktree, newest first. Left out: a branch checked out in a
  //    worktree or in the main checkout (and its remote copy), the default branch's own remote
  //    copy, and a remote copy of a local branch that is listed too (one branch, one copy).
  const [remoteOut, headsOut, mergedOut, mainHead, allRefs] = await Promise.all([
    gitAsync(realRoot, ['remote']),
    gitAsync(realRoot, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']),
    gitAsync(realRoot, ['branch', '-a', '--merged', base, '--format=%(refname:short)']),
    gitAsync(realRoot, ['rev-parse', '--abbrev-ref', 'HEAD']),
    refsAsync(realRoot),
  ]);
  const remotes = lines(remoteOut);
  const heads = new Set(lines(headsOut));
  const merged = new Set(lines(mergedOut));
  const isRemote = (name: string) => !heads.has(name) && remotes.some((x) => name.startsWith(`${x}/`));
  const local = (name: string) => { const r = isRemote(name) ? remotes.find((x) => name.startsWith(`${x}/`)) : undefined; return r ? name.slice(r.length + 1) : name; };
  const checkedOut = new Set(wts.map((w) => w.branch).filter(Boolean) as string[]);
  const current = mainHead?.trim();
  if (current && current !== 'HEAD') checkedOut.add(current); // 'HEAD' is a detached checkout
  const candidates = allRefs.filter((b) => b.name !== base && local(b.name) !== local(base) && !merged.has(b.name) && !checkedOut.has(b.name) && !checkedOut.has(local(b.name)));
  const kept = new Set(candidates.filter((b) => !isRemote(b.name)).map((b) => b.name));
  const branches = candidates
    .filter((b) => !(isRemote(b.name) && kept.has(local(b.name))))
    .sort((a, b) => b.date - a.date).slice(0, DOCS_BRANCHES);
  for (const b of branches) {
    for (const rel of names(await gitAsync(realRoot, ['diff', '-z', '--name-only', `${base}...${b.name}`, '--', ...DOC_FOLDERS]))) {
      if (!isDoc(rel)) continue;
      const size = await blobSizeAsync(realRoot, b.name, rel);
      if (size === null || !Number.isFinite(size) || size > DOC_MAX_BYTES) continue; // deleted on the branch, or too large
      const bytes = await readBlobAsync(realRoot, b.name, rel);
      if (!bytes) continue;
      const v = await vs(rel, bytes);
      if (!v) continue;
      const when = (await commitDateAsync(realRoot, b.name, rel)) ?? new Date(b.date * 1000).toISOString();
      copies.push({ path: rel, status: statusLine(bytes.toString('utf8')), source: 'branch', worktree: null, worktreeRel: null, branch: b.name, vsMain: v, modifiedAt: when, at: Date.parse(when), worktreeReal: null });
    }
  }

  // 3. One row per path, the newest copy wins.
  const byPath = new Map<string, Copy[]>();
  for (const c of copies) byPath.set(c.path, [...(byPath.get(c.path) ?? []), c]);
  const best = [...byPath.values()].map((list) => ({ list, top: list.sort((a, b) => b.at - a.at)[0] })).sort((a, b) => b.top.at - a.top.at);
  // The writer lookup reads the DB, so it runs only for the rows that are shown.
  const rows: DocRow[] = best.slice(0, DOCS_ROWS).map(({ list, top }) => {
    const { at: _at, worktreeReal, ...row } = top;
    return { ...row, name: path.basename(top.path), copies: list.length, writer: writerOf({ path: top.path, worktreeReal }) };
  });
  return { rows, total: best.length };
};
