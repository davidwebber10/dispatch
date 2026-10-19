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
 */
import fs from 'node:fs';
import path from 'node:path';
import { projectWorktrees } from '../overseer/source-file.js';
import { isRepo, refs, defaultBranch, blobHash, blobSize, readBlob, hashBytes, commitDate, git } from './git.js';
import { statusLine, DOC_MAX_BYTES } from './resolve.js';

export const DOC_FOLDERS = ['docs/superpowers/specs', 'docs/superpowers/plans', 'docs/specs', 'docs/plans'];
export const DOCS_ROWS = 5;
export const DOCS_BRANCHES = 20;
export const DOCS_CACHE_MS = 60_000;
export interface DocRow { path: string; name: string; status: string | null; source: 'worktree' | 'branch'; worktree: string | null; branch: string | null; vsMain: 'changed' | 'not_on_main'; modifiedAt: string; copies: number; writer: { id: string; label: string } | null }

const lines = (s: string | null) => (s ?? '').split('\n').map((x) => x.trim()).filter(Boolean);
/** `-z` output: NUL-separated, never quoted (a name with spaces or non-ASCII stays as it is). */
const names = (s: string | null) => (s ?? '').split('\0').filter(Boolean);
const isDoc = (p: string) => /\.md$/i.test(p) && DOC_FOLDERS.some((f) => p.startsWith(`${f}/`));
const NONE = () => ({ rows: [] as DocRow[], total: 0 });

export function listDocs(project: { id: string; folder: string }, writerOf: (c: { path: string; worktreeReal: string | null }) => { id: string; label: string } | null): { rows: DocRow[]; total: number } {
  let realRoot: string;
  try { realRoot = fs.realpathSync.native(project.folder); } catch { return NONE(); }
  if (!isRepo(realRoot)) return NONE();
  const base = defaultBranch(realRoot);
  if (!base) return NONE();
  type Copy = Omit<DocRow, 'copies' | 'writer' | 'name'> & { at: number; worktreeReal: string | null };
  const copies: Copy[] = [];
  const vs = (rel: string, bytes: Buffer): DocRow['vsMain'] | null => {
    const h = blobHash(realRoot, base, rel);
    return h === null ? 'not_on_main' : h === hashBytes(bytes) ? null : 'changed';
  };

  // 1. Worktrees. A folder under .worktrees that is not a worktree of its own would run git in
  //    the main checkout, so only a folder that is its own work tree top counts.
  const wts = projectWorktrees(realRoot).filter((w) => isRepo(w.real));
  for (const w of wts) {
    const changed = names(git(w.real, ['diff', '-z', '--name-only', base, '--', ...DOC_FOLDERS]));
    const untracked = names(git(w.real, ['ls-files', '-z', '--others', '--exclude-standard', '--', ...DOC_FOLDERS]));
    for (const rel of new Set([...changed, ...untracked])) {
      if (!isDoc(rel)) continue;
      const file = path.join(w.real, rel);
      let st: fs.Stats; try { st = fs.statSync(file); } catch { continue; } // deleted in the worktree
      if (!st.isFile() || st.size > DOC_MAX_BYTES) continue;
      let bytes: Buffer; try { bytes = fs.readFileSync(file); } catch { continue; }
      const v = vs(rel, bytes);
      if (!v) continue;
      copies.push({ path: rel, status: statusLine(bytes.toString('utf8')), source: 'worktree', worktree: w.name, branch: w.branch, vsMain: v, modifiedAt: st.mtime.toISOString(), at: st.mtimeMs, worktreeReal: w.real });
    }
  }

  // 2. Unmerged branches with no worktree, newest first. A remote branch whose local name is
  //    checked out in a worktree, or that is the default branch's own remote copy, is left out.
  const remotes = lines(git(realRoot, ['remote']));
  const local = (name: string) => { const r = remotes.find((x) => name.startsWith(`${x}/`)); return r ? name.slice(r.length + 1) : name; };
  const checkedOut = new Set(wts.map((w) => w.branch).filter(Boolean) as string[]);
  const merged = new Set(lines(git(realRoot, ['branch', '-a', '--merged', base, '--format=%(refname:short)'])));
  const branches = refs(realRoot)
    .filter((b) => b.name !== base && local(b.name) !== local(base) && !merged.has(b.name) && !checkedOut.has(b.name) && !checkedOut.has(local(b.name)))
    .sort((a, b) => b.date - a.date).slice(0, DOCS_BRANCHES);
  for (const b of branches) {
    for (const rel of names(git(realRoot, ['diff', '-z', '--name-only', `${base}...${b.name}`, '--', ...DOC_FOLDERS]))) {
      if (!isDoc(rel)) continue;
      const size = blobSize(realRoot, b.name, rel);
      if (size === null || !Number.isFinite(size) || size > DOC_MAX_BYTES) continue; // deleted on the branch, or too large
      const bytes = readBlob(realRoot, b.name, rel);
      if (!bytes) continue;
      const v = vs(rel, bytes);
      if (!v) continue;
      const when = commitDate(realRoot, b.name, rel) ?? new Date(b.date * 1000).toISOString();
      copies.push({ path: rel, status: statusLine(bytes.toString('utf8')), source: 'branch', worktree: null, branch: b.name, vsMain: v, modifiedAt: when, at: Date.parse(when), worktreeReal: null });
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
}
