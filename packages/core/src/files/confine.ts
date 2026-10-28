import fs from 'node:fs';
import path from 'node:path';

/**
 * True when `target`, once every symlink on the way is followed, is inside the real project folder
 * `root` (or is the folder itself). The routes compare path text first (a `..` check); text alone cannot
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
  const rel = path.relative(realRoot, path.join(real, ...rest));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}
