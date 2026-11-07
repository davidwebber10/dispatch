import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/** A marketplace as a bare git repository, with a working clone the test commits into (plugins slice 6). */
export function makeMarket() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'market-')));
  const bare = path.join(root, 'market.git');
  const work = path.join(root, 'work');
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  const g = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] });
  fs.mkdirSync(bare); g(bare, 'init', '-q', '--bare', '-b', 'main');
  g(root, 'clone', '-q', bare, work);
  const write = (rel: string, text: string) => { const f = path.join(work, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
  const commit = (msg: string) => { g(work, 'add', '-A'); g(work, 'commit', '-q', '-m', msg); g(work, 'push', '-q', 'origin', 'main'); return g(work, 'rev-parse', 'HEAD').trim(); };
  const plugin = (id: string, version: string, extra: Record<string, unknown> = {}) => {
    write(`plugins/${id}/plugin.json`, JSON.stringify({ id, name: `The ${id} plugin`, version, description: `${id} does things`, web: 'web.js', ...extra }));
    write(`plugins/${id}/web.js`, `export default function activate(d) { d.register(d.id, { views: [{ id: 'v', label: 'V ${version}', Component: () => null }] }); }`);
    write(`plugins/${id}/CHANGELOG.md`, `# Changelog\n\n## ${version}\n\nThe ${version} notes.\n`);
  };
  const skill = (id: string, version: string) => {
    write(`skills/${id}/skill.json`, JSON.stringify({ id, name: `The ${id} skill`, version, description: `${id} helps` }));
    write(`skills/${id}/SKILL.md`, `# ${id}\n\nAlways ${id} first.\n`);
  };
  write('marketplace.json', JSON.stringify({ name: 'Test market', description: 'For the tests' }));
  plugin('hello', '1.0.0'); skill('tidy', '0.1.0');
  const first = commit('first');
  return { root, bare, work, url: bare, write, commit, plugin, skill, first, rm: () => fs.rmSync(root, { recursive: true, force: true }) };
}
