// Path checks that follow symlinks, shared by the coordinator write policy (coordinator-policy.ts)
// and the overseer memory folders (memory-scope.ts). Moved out of coordinator-policy.ts unchanged,
// so memory-scope.ts can use them without an import cycle.
import fs from 'node:fs';
import path from 'node:path';

/** Resolve `p` following symlinks as far as it exists on disk, then re-append the not-yet-existing
 *  tail. A new file's parent dir usually exists even when the file does not, so this catches a
 *  symlinked ancestor (e.g. `~/.codex/link -> /repo`) that a purely lexical resolve would miss.
 *  THROWS when a path component EXISTS but does not resolve — a dangling symlink or a symlink loop —
 *  rather than lexically re-appending past it (which would let `~/.codex/dangling -> /repo/x`
 *  resolve back "under" the memory dir). The caller (isUnder) fails closed on the throw. */
export function realResolve(abs: string): string {
  // Callers pass an ABSOLUTE path (isUnder denies a relative target before it gets here).
  // Walk the ORIGINAL segments rather than path.resolve-ing them: path.resolve would fold `link/..`
  // to nothing BEFORE symlinks resolve, hiding a `link/../escape` traversal. (isUnder also rejects
  // any raw `..` segment outright, so this is a second line, not the only one.)
  if (!path.isAbsolute(abs)) throw new Error(`coordinator-policy: not an absolute path ${abs}`);
  const segs = abs.split(path.sep);
  const tail: string[] = [];
  for (let i = segs.length; i > 0; i--) {
    const prefix = segs.slice(0, i).join(path.sep) || path.sep;
    try {
      const real = fs.realpathSync(prefix);
      return tail.length ? path.join(real, ...tail.slice().reverse()) : real;
    } catch (realErr: unknown) {
      // Only a clean ENOENT ("this prefix does not exist yet") lets us keep walking up. Any other
      // realpath error — EACCES, ELOOP (symlink loop), EIO, ENOTDIR — is NOT safely resolvable, so
      // fail closed rather than reconstruct an unchecked lexical path.
      if ((realErr as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        throw new Error(`coordinator-policy: unresolvable path (${(realErr as NodeJS.ErrnoException)?.code ?? 'unknown'}) ${prefix}`);
      }
      // ENOENT from realpath: does this exact prefix still EXIST on disk? A dangling symlink is
      // ENOENT to realpath but present to lstat (which does not follow the final link). If it
      // exists, it is dangling/unresolvable — fail closed instead of re-appending past it.
      let exists = false;
      let lstatErr: unknown = null;
      try { fs.lstatSync(prefix); exists = true; } catch (e) { lstatErr = e; }
      if (exists) throw new Error(`coordinator-policy: unresolvable path component ${prefix}`);
      if ((lstatErr as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        throw new Error(`coordinator-policy: unstattable path (${(lstatErr as NodeJS.ErrnoException)?.code ?? 'unknown'}) ${prefix}`);
      }
      tail.push(segs[i - 1]); // truly absent → keep walking up
    }
  }
  return abs; // nothing on the path existed — lexical absolute (won't be under an existing memoryDir)
}

/** True when `target` resolves to a path strictly inside the memory dir `rd` (not `rd` itself).
 *  `rd` is a memory dir's REAL path, resolved once when the policy is built (null when it could
 *  not be resolved — then nothing is under it). The target resolves through `realResolve`, so
 *  neither a traversal segment nor a symlinked ancestor can slip a path that only *textually*
 *  starts with the dir past the check. A RELATIVE target is denied: the harness would anchor it
 *  to the thread's cwd, not the daemon's, so resolving it here would check the wrong file (and a
 *  coordinator's memory path is always absolute anyway). Fails closed (false) when the target is
 *  unresolvable (dangling symlink / loop / EACCES). */
export function isUnder(rd: string | null, target: string): boolean {
  if (rd === null) return false;
  if (!path.isAbsolute(target)) return false;
  // Reject ANY `..` segment in the raw target outright. After a symlink, `..` is resolved
  // differently by realpathSync (lexically, to the link's own parent) than by the kernel at write
  // time (to the link TARGET's parent), so `mem/link/../escape` can pass a realpath-based check yet
  // write OUTSIDE the memory dir. A coordinator's own memory path never needs `..`; deny it rather
  // than trust either resolution to agree with the eventual write.
  if (target.split(/[/\\]/).includes('..')) return false;
  let rt: string;
  try {
    rt = realResolve(target);
  } catch {
    return false;
  }
  const rel = path.relative(rd, rt);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}
