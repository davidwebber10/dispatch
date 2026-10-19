/**
 * The doc resolver (chat thread visibility spec, 12.5): finds the right copy of a spec or plan
 * doc that a Chat message names, and says how it compares to main. Read only.
 *
 * Order: first an explicitly named copy (a worktree by name; or a listed branch: the copy on disk
 * in the worktree that has it checked out, else its blob), when it has the file; then the path on
 * disk (the main checkout, or a worktree path as given); for a path inside a
 * removed worktree, the named branch, then the branch that ends in the worktree name, then the
 * main checkout; otherwise the copies in the project's worktrees (newest first), then the
 * newest DOCS_BRANCHES unmerged branches (newest first). A branch is tried at most once.
 *
 * Safety:
 * - Only real paths inside the project folder; a worktree counts only when its real path is
 *   inside it; a symlink that leads out is refused; `..` that leads out is refused before any read.
 * - Only `.md`, `.markdown` and `.txt`, regular files only, at most 2 MB (a branch blob's size
 *   is checked with `git cat-file -s` before it is read).
 * - A branch is used only when it is one that `git for-each-ref` listed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { leadsOut, projectRelative, locate, projectWorktrees } from '../overseer/source-file.js';
import { isRepo, refs, defaultBranch, blobHash, blobSize, readBlob, hashBytes, commitDate, git, currentBranch, DOCS_BRANCHES } from './git.js';

export const DOC_MAX_BYTES = 2 * 1024 * 1024;
export const DOC_EXT = /\.(md|markdown|txt)$/i;
export interface DocCopy { project: string; path: string; absPath: string | null; source: 'main' | 'worktree' | 'branch'; worktree: string | null; branch: string | null; vsMain: 'same' | 'changed' | 'not_on_main' | 'unknown'; modifiedAt: string; status: string | null; note: string | null; markdown: string }
export type DocResult = { kind: 'doc'; doc: DocCopy } | { kind: 'not_found'; looked: string[] } | { kind: 'refused'; reason: string } | { kind: 'too_large'; path: string; size: number };

const WT = /^(\.claude\/worktrees|\.worktrees)\/([^/]+)\/(.+)$/;
const posix = (p: string) => p.split(path.sep).join('/');
const OUTSIDE: DocResult = { kind: 'refused', reason: 'This path is outside the project.' };
const NOT_A_DOC: DocResult = { kind: 'refused', reason: 'Only .md, .markdown and .txt files open here.' };

/** The first `Status:` line in the first 20 lines, at most 60 characters. */
export function statusLine(text: string): string | null {
  for (const line of text.split('\n').slice(0, 20)) {
    const m = /^\s*Status:\s*(.+?)\s*$/i.exec(line);
    if (m) return m[1].slice(0, 60);
  }
  return null;
}

export function resolveDoc(project: { id: string; folder: string }, ref: string, opts: { branch?: string | null; worktree?: string | null } = {}): DocResult {
  let realRoot: string;
  try { realRoot = fs.realpathSync.native(project.folder); } catch { return { kind: 'not_found', looked: [project.folder] }; }
  if (path.sep === '/' && ref.includes('\\')) return OUTSIDE;
  const rel = projectRelative(project.folder, realRoot, ref);
  if (rel === null) return OUTSIDE;
  if (!DOC_EXT.test(rel)) return NOT_A_DOC;
  const repo = isRepo(realRoot);
  const known = repo ? refs(realRoot) : [];
  const base = repo ? defaultBranch(realRoot, known) : null;
  const wts = projectWorktrees(realRoot);
  const looked: string[] = [];

  const vs = (mainRel: string, bytes: Buffer): DocCopy['vsMain'] => {
    if (!base) return 'unknown';
    const h = blobHash(realRoot, base, mainRel);
    return h === null ? 'not_on_main' : h === hashBytes(bytes) ? 'same' : 'changed';
  };
  const fromDisk = (real: string, inRoot: string): DocResult => {
    let st: fs.Stats;
    try { st = fs.statSync(real); } catch { return { kind: 'not_found', looked }; }
    if (st.isDirectory()) return { kind: 'refused', reason: 'This path is a folder, not a file.' };
    if (!st.isFile()) return { kind: 'refused', reason: 'This path is not a regular file.' };
    // A symlink inside the project that leads to another kind of file is not a doc either.
    if (!DOC_EXT.test(real)) return NOT_A_DOC;
    if (st.size > DOC_MAX_BYTES) return { kind: 'too_large', path: posix(inRoot), size: st.size };
    let bytes: Buffer;
    try { bytes = fs.readFileSync(real); } catch { return { kind: 'not_found', looked }; }
    if (bytes.length > DOC_MAX_BYTES) return { kind: 'too_large', path: posix(inRoot), size: bytes.length };
    const w = wts.find((x) => inRoot === x.rel || inRoot.startsWith(x.rel + path.sep));
    const docRel = w ? path.relative(w.rel, inRoot) : inRoot;
    const text = bytes.toString('utf8');
    return { kind: 'doc', doc: { project: project.id, path: posix(docRel), absPath: real, source: w ? 'worktree' : 'main', worktree: w?.name ?? null, branch: w?.branch ?? null, vsMain: vs(docRel, bytes), modifiedAt: st.mtime.toISOString(), status: statusLine(text), note: null, markdown: text } };
  };
  const fromBranch = (branch: string, docRel: string, note: string | null = null): DocResult | null => {
    if (!known.some((k) => k.name === branch)) return null;
    const size = blobSize(realRoot, branch, docRel);
    if (size === null || !Number.isFinite(size)) return null;
    if (size > DOC_MAX_BYTES) return { kind: 'too_large', path: posix(docRel), size };
    const bytes = readBlob(realRoot, branch, docRel);
    if (!bytes) return null;
    if (bytes.length > DOC_MAX_BYTES) return { kind: 'too_large', path: posix(docRel), size: bytes.length };
    const text = bytes.toString('utf8');
    return { kind: 'doc', doc: { project: project.id, path: posix(docRel), absPath: null, source: 'branch', worktree: null, branch, vsMain: vs(docRel, bytes), modifiedAt: commitDate(realRoot, branch, docRel) ?? new Date((known.find((k) => k.name === branch)?.date ?? 0) * 1000).toISOString(), status: statusLine(text), note, markdown: text } };
  };
  /** The branch blobs already tried: each branch is read (and listed in `looked`) once. */
  const tried = new Set<string>();
  const tryBranch = (branch: string, docRel: string, note: string | null = null): DocResult | null => {
    if (tried.has(branch)) return null;
    tried.add(branch);
    looked.push(`${branch}:${posix(docRel)}`);
    return fromBranch(branch, docRel, note);
  };
  /** The worktree copy of `rel`, or null when that worktree does not have it. */
  const inWorktree = (w: { rel: string }): DocResult | null => {
    const inRoot = path.join(w.rel, rel);
    looked.push(posix(inRoot));
    const real = locate(realRoot, inRoot);
    if (real === 'outside') return OUTSIDE;
    if (real === 'missing') return null;
    const r = fromDisk(real, inRoot);
    return r.kind === 'not_found' ? null : r;
  };
  /** The copy that `opts` names, or null (no name, an unknown name, or the copy lacks the file). */
  const namedCopy = (): DocResult | null => {
    const byName = opts.worktree ? wts.find((w) => w.name === opts.worktree) : undefined;
    if (byName) {
      const r = inWorktree(byName);
      if (r) return r;
    }
    const b = opts.branch;
    if (!b || !known.some((k) => k.name === b)) return null;
    const remotes = (git(realRoot, ['remote']) ?? '').split('\n').map((s) => s.trim()).filter(Boolean);
    // The main checkout's own branch reads the live file there (step 1), not the committed blob.
    const mainBranch = currentBranch(realRoot);
    if (mainBranch && (b === mainBranch || remotes.some((rm) => b === `${rm}/${mainBranch}`))) return null;
    // A checked-out worktree that lacks the file falls back to the normal order (by design).
    const checkedOut = wts.find((w) => w.branch && (w.branch === b || remotes.some((rm) => b === `${rm}/${w.branch}`)));
    if (checkedOut) return inWorktree(checkedOut);
    return tryBranch(b, rel);
  };
  const unmerged = (): { name: string; date: number }[] => {
    if (!base) return [];
    const merged = new Set((git(realRoot, ['branch', '-a', '--merged', base, '--format=%(refname:short)']) ?? '').split('\n').map((s) => s.trim()).filter(Boolean));
    return known.filter((k) => k.name !== base && !merged.has(k.name)).sort((a, b) => b.date - a.date).slice(0, DOCS_BRANCHES);
  };

  const wt = WT.exec(posix(rel));
  // 0. An explicitly named copy (a path inside a worktree already names its copy).
  if (!wt) {
    const named = namedCopy();
    if (named) return named;
  }

  // 1. On disk.
  looked.push(posix(rel));
  const found = locate(realRoot, rel);
  if (found === 'outside') return OUTSIDE;
  if (found !== 'missing') return fromDisk(found, rel);

  if (wt) {
    // 3. A path inside a removed worktree: the named branch, the branch that ends in its name, the main checkout.
    const rest = path.normalize(wt[3]);
    if (leadsOut(rest)) return OUTSIDE;
    const byName = known.filter((k) => k.name === wt[2] || k.name.endsWith(`/${wt[2]}`)).sort((a, b) => b.date - a.date)[0]?.name;
    const wtGone = !fs.existsSync(path.join(realRoot, wt[1], wt[2]));
    const lead = wtGone ? `The worktree "${wt[2]}" is gone` : `The worktree "${wt[2]}" does not have this file`;
    for (const b of [opts.branch, byName]) {
      if (!b) continue;
      const r = tryBranch(b, rest, `${lead}; read from the branch.`);
      if (r) return r;
    }
    looked.push(posix(rest));
    const main = locate(realRoot, rest);
    if (main === 'outside') return OUTSIDE;
    if (main !== 'missing') {
      const r = fromDisk(main, rest);
      if (r.kind === 'doc') r.doc.note = `${lead}; this is the main checkout copy.`;
      return r;
    }
    for (const b of unmerged()) {
      const r = tryBranch(b.name, rest, `${lead}; read from the branch.`);
      if (r) return r;
    }
    return { kind: 'not_found', looked };
  }

  // 2. Worktree copies, newest first.
  const copies = wts.flatMap((w) => {
    const real = locate(realRoot, path.join(w.rel, rel));
    if (real === 'missing' || real === 'outside') return [];
    try { return [{ w, real, mtime: fs.statSync(real).mtimeMs }]; } catch { return []; }
  }).sort((a, b) => b.mtime - a.mtime);
  for (const w of wts) looked.push(posix(path.join(w.rel, rel)));
  if (copies.length) {
    const r = fromDisk(copies[0].real, path.join(copies[0].w.rel, rel));
    if (r.kind === 'doc' && copies.length > 1) r.doc.note = `The newest of ${copies.length} copies.`;
    return r;
  }

  // 4. Unmerged branches, newest first.
  for (const b of unmerged()) {
    const r = tryBranch(b.name, rel);
    if (r) return r;
  }
  return { kind: 'not_found', looked };
}
