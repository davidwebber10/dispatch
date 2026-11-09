// A temporary git repository for the W3-G tests. Never used by the daemon (excluded from the build).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export interface TestRepo {
  dir: string;
  git: (...args: string[]) => string;
  write: (rel: string, content: string | Buffer) => void;
  read: (rel: string) => string;
  exists: (rel: string) => boolean;
  /** `git status --porcelain=v1 -uall`, one line per record. */
  status: () => string;
  cleanup: () => void;
}

export function gitIn(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
  });
}

/** A repository with one commit: a.txt, b.txt, dir/c.txt, old-name.txt (12 lines) and logo.bin. */
export function makeRepo(prefix = 'dispatch-w3g-'): TestRepo {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  const git = (...args: string[]) => gitIn(dir, ...args);
  const write = (rel: string, content: string | Buffer) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  };
  git('init', '-q', '-b', 'main', '.');
  write('a.txt', 'one\ntwo\nthree\n');
  write('b.txt', 'bee\n');
  write('dir/c.txt', 'sea\n');
  write('old-name.txt', Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join('\n') + '\n');
  write('logo.bin', Buffer.from([0, 1, 2, 3, 0, 255, 254, 0]));
  git('add', '-A');
  git('commit', '-qm', 'first');
  return {
    dir, git, write,
    read: (rel) => fs.readFileSync(path.join(dir, rel), 'utf8'),
    exists: (rel) => fs.existsSync(path.join(dir, rel)),
    status: () => git('status', '--porcelain=v1', '-uall'),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}
