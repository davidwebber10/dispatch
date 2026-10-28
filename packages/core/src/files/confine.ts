import fs from 'node:fs';
import path from 'node:path';

/**
 * Extra folders a link may lead into, besides the project itself: `DISPATCH_FILE_ROOTS`, a list split
 * with the OS path delimiter (":" on macOS/Linux). For a project that links to a shared folder or a
 * sibling package outside it. Set it to "/" to allow any link target (the checks off).
 */
export function extraRoots(): string[] {
  const raw = process.env.DISPATCH_FILE_ROOTS;
  if (!raw) return [];
  const out: string[] = [];
  for (const part of raw.split(path.delimiter)) {
    if (!part.trim()) continue;
    try { out.push(fs.realpathSync(path.resolve(part.trim()))); } catch { /* a folder that is gone allows nothing */ }
  }
  return out;
}

export function within(root: string, real: string): boolean {
  const rel = path.relative(root, real);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/**
 * True when `target`, once every symlink on the way is followed, is inside the real project folder
 * `root` (or is the folder itself), or inside a folder listed in `DISPATCH_FILE_ROOTS`. A link that stays
 * inside the project (a workspace link, `node_modules/.pnpm`, an alias) always works. The routes compare path text first (a `..` check); text alone cannot
 * see a symlink inside the project that leads out of it.
 *
 * - A path that exists is checked by its own realpath. A dangling or looping symlink does not resolve,
 *   so it is refused: a write through it would create a file at the link target.
 * - A path that does not exist yet (a new file, or `mkdir -p`) is checked by the realpath of its nearest
 *   existing parent folder.
 */
export function insideRealRoot(root: string, target: string): boolean {
  let realRoot: string;
  try { realRoot = fs.realpathSync(path.resolve(root)); } catch { return false; }
  let probe = path.resolve(target);
  const rest: string[] = [];
  for (;;) {
    try {
      fs.lstatSync(probe);
      break; // it exists (a symlink counts, even a dangling one)
    } catch (e) {
      // ENOTDIR: a parent is a plain file. Nothing leaves the project through it; the real operation fails on its own.
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') return false;
    }
    const parent = path.dirname(probe);
    if (parent === probe) return false;
    rest.unshift(path.basename(probe));
    probe = parent;
  }
  let real: string;
  try { real = fs.realpathSync(probe); } catch { return false; }
  const full = path.join(real, ...rest);
  if ([realRoot, ...extraRoots()].some((r) => within(r, full))) return true;
  // A project folder inside a workspace (repo/packages/web) has node_modules links to repo/node_modules/.pnpm/...,
  // outside the project. Dependency folders are not a way to a private file: a path that goes through node_modules and
  // lands inside another node_modules folder is allowed. A link into /etc or a home folder is still refused.
  return inNodeModules(path.resolve(target)) && inNodeModules(full);
}

const NODE_MODULES = `${path.sep}node_modules${path.sep}`;
function inNodeModules(p: string): boolean {
  return `${p}${path.sep}`.includes(NODE_MODULES);
}
