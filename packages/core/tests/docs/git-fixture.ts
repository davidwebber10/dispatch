import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/** A throwaway repo under a fresh temp folder. `rm()` removes only that folder. */
export function makeRepo() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ctv-')));
  const dir = path.join(root, 'project');
  fs.mkdirSync(dir);
  const g = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  g(dir, 'init', '-q', '-b', 'main');
  const write = (rel: string, text: string, cwd = dir) => { const f = path.join(cwd, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
  const commit = (msg: string, cwd = dir) => { g(cwd, 'add', '-A'); g(cwd, 'commit', '-q', '-m', msg); };
  return { root, dir, g, write, commit, rm: () => fs.rmSync(root, { recursive: true, force: true }) };
}
