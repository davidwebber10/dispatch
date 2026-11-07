import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { parseManifest, isMarketplaceUrl, compareVersions, PLUGIN_ID_RE } from 'dispatch-server/plugins';

/**
 * `dispatch plugin publish <folder> --to <marketplace>` (docs/superpowers/specs/2026-11-07-plugins-design.md,
 * section 7): a marketplace is a git repository, so publishing is a branch and a pull request. The
 * command clones the marketplace into a temp folder with the author's own git credentials, refuses a
 * version that is not newer than the catalog's, copies the folder to `plugins/<id>` (no node_modules,
 * no install record, no symlinks), commits on `plugin/<id>-<version>`, pushes, and opens the pull
 * request through `gh` when it is installed (else prints the compare URL). The local plugin stays local.
 */
export type Runner = (cmd: string, args: string[], opts: { cwd: string }) => { code: number; stdout: string; stderr: string };
export interface PublishOptions {
  folder: string;
  /** A marketplace URL, or the slug of one the daemon knows (`~/.dispatch/marketplaces.json`). */
  marketplace: string;
  branch?: string;
  dryRun?: boolean;
  run?: Runner;
  log?: (line: string) => void;
  tmpDir?: string;
  dataDir?: string;
  /** Test seam: the GitHub URL of a marketplace that is not itself a GitHub URL (a local mirror). */
  githubUrlFor?: (url: string) => string | null;
}
export interface PublishResult { id: string; version: string; branch: string; prUrl: string | null; compareUrl: string | null }

const defaultRun: Runner = (cmd, args, opts) => {
  const r = spawnSync(cmd, args, { cwd: opts.cwd, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  return { code: r.error ? 127 : r.status ?? 1, stdout: r.stdout ?? '', stderr: r.error ? r.error.message : r.stderr ?? '' };
};
/** The line that explains a git or gh failure: Permission denied, else the last fatal/error line, else the last line. */
const lastLine = (s: string): string => {
  const lines = s.split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.find((l) => /permission denied|authentication failed|403/i.test(l)) ?? [...lines].reverse().find((l) => /^(fatal|error|remote):/i.test(l)) ?? lines.pop() ?? 'failed';
};
/** A folder over this is refused: a plugin is code and a few assets. */
export const PUBLISH_MAX_BYTES = 10 * 1024 * 1024;

/** A GitHub https or ssh URL → `https://github.com/<owner>/<repo>`; null for any other host. */
export function githubWebUrl(url: string): string | null {
  const m = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url);
  return m ? `https://github.com/${m[1]}/${m[2]}` : null;
}

function resolveMarketplace(spec: string, dataDir: string | undefined): string {
  if (isMarketplaceUrl(spec)) return spec;
  if (/^[a-z0-9-]+$/.test(spec)) {
    const file = path.join(dataDir ?? path.join(os.homedir(), '.dispatch'), 'marketplaces.json');
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { marketplaces?: { url?: string; slug?: string }[] };
      const row = (raw.marketplaces ?? []).find((m) => m.slug === spec);
      if (row?.url) return row.url;
    } catch { /* no list */ }
    throw new Error(`no marketplace named "${spec}" in ${file}; pass its URL`);
  }
  throw new Error('not a marketplace: pass an https://, ssh://, git@host:path URL, an absolute path, or the slug of one the daemon knows');
}

/**
 * The files to publish, relative to the folder: regular files only, no symlinks, no hidden files or
 * folders (a `.env` or `.npmrc` must never reach a marketplace), no node_modules, nothing the
 * plugin's own `.gitignore` names (simple patterns: a name, `dir/`, `*.ext`).
 */
export function publishableFiles(folder: string): { files: string[]; bytes: number } {
  const ignore: ((rel: string, isDir: boolean) => boolean)[] = [];
  try {
    for (const raw of fs.readFileSync(path.join(folder, '.gitignore'), 'utf8').split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#') || line.startsWith('!')) continue;
      const dirOnly = line.endsWith('/');
      const pat = line.replace(/^\//, '').replace(/\/$/, '');
      const re = new RegExp(`^${pat.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')}$`);
      ignore.push((rel, isDir) => (dirOnly ? isDir : true) && (re.test(rel) || re.test(path.basename(rel))));
    }
  } catch { /* no .gitignore */ }
  const files: string[] = []; let bytes = 0;
  const walk = (dir: string, rel: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith('.') || e.name === 'node_modules' || e.isSymbolicLink()) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (ignore.some((f) => f(r, e.isDirectory()))) continue;
      if (e.isDirectory()) walk(path.join(dir, e.name), r);
      else if (e.isFile()) { files.push(r); bytes += fs.statSync(path.join(dir, e.name)).size; }
    }
  };
  walk(folder, '');
  return { files: files.sort(), bytes };
}

export async function publishPlugin(o: PublishOptions): Promise<PublishResult> {
  const run = o.run ?? defaultRun;
  const log = o.log ?? (() => {});
  const folder = path.resolve(o.folder);
  let raw: string;
  try { raw = fs.readFileSync(path.join(folder, 'plugin.json'), 'utf8'); } catch { throw new Error(`no plugin.json in ${folder}`); }
  const parsed = parseManifest(raw, path.basename(folder));
  if (!parsed.ok) throw new Error(parsed.error);
  const { id, version } = parsed.manifest;
  if (!PLUGIN_ID_RE.test(id)) throw new Error(`"${id}" is not a plugin id: lowercase letters, digits and dashes`);
  const url = resolveMarketplace(o.marketplace, o.dataDir);
  const { files, bytes } = publishableFiles(folder);
  if (bytes > PUBLISH_MAX_BYTES) throw new Error(`the plugin is larger than 10 MB (${Math.round(bytes / 1024 / 1024)} MB); leave build output and assets out (.gitignore)`);
  log(`Files: ${files.join(', ')}`);
  const parent = o.tmpDir ?? os.tmpdir();
  fs.mkdirSync(parent, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(parent, 'dispatch-publish-'));
  try {
    const repo = path.join(tmp, 'repo');
    log(`Cloning ${url}…`);
    const clone = run('git', ['clone', '--quiet', '--', url, repo], { cwd: tmp });
    if (clone.code !== 0) throw new Error(`clone failed: ${lastLine(clone.stderr)}`);
    const existingFile = path.join(repo, 'plugins', id, 'plugin.json');
    if (fs.existsSync(existingFile)) {
      let existing: string | null = null;
      try { existing = (JSON.parse(fs.readFileSync(existingFile, 'utf8')) as { version?: string }).version ?? null; } catch { existing = null; }
      if (existing && compareVersions(version, existing) <= 0) throw new Error(`${id} ${version} is not newer than ${existing} in the marketplace; bump the version in plugin.json`);
    }
    const branch = o.branch ?? `plugin/${id}-${version}`;
    const co = run('git', ['checkout', '-q', '-b', branch], { cwd: repo });
    if (co.code !== 0) throw new Error(`branch failed: ${lastLine(co.stderr)}`);
    const dest = path.join(repo, 'plugins', id);
    fs.rmSync(dest, { recursive: true, force: true });
    for (const f of files) { fs.mkdirSync(path.dirname(path.join(dest, f)), { recursive: true }); fs.copyFileSync(path.join(folder, f), path.join(dest, f)); }
    run('git', ['add', '-A', '--', `plugins/${id}`], { cwd: repo });
    // The author's own identity when git has one; a fixed one only when it has none.
    const hasIdentity = run('git', ['config', 'user.email'], { cwd: repo }).stdout.trim() !== '';
    const ident = hasIdentity ? [] : ['-c', 'user.name=dispatch plugin publish', '-c', 'user.email=dispatch@localhost'];
    const commit = run('git', [...ident, 'commit', '-q', '-m', `plugins: ${id} ${version}`], { cwd: repo });
    if (commit.code !== 0) throw new Error(`nothing to publish: ${lastLine(commit.stderr) || 'the marketplace already has these files'}`);
    if (o.dryRun) { log(`Dry run: ${id} ${version} would go to ${url} on ${branch}. Nothing was pushed.`); return { id, version, branch, prUrl: null, compareUrl: null }; }
    log(`Pushing ${branch}…`);
    const web = githubWebUrl(url) ?? (o.githubUrlFor ? githubWebUrl(o.githubUrlFor(url) ?? '') : null);
    const upstream = web ? web.replace('https://github.com/', '') : null;
    let head = branch;
    const push = run('git', ['push', '-q', '-u', 'origin', branch], { cwd: repo });
    if (push.code !== 0) {
      // No write access to a GitHub marketplace: fork it with gh, push to the fork, open the PR upstream.
      const login = upstream ? run('gh', ['api', 'user', '--jq', '.login'], { cwd: repo }) : null;
      if (!upstream || !login || login.code !== 0 || !login.stdout.trim()) throw new Error(`push failed: ${lastLine(push.stderr)}${upstream ? ' (sign in with gh auth login to publish through a fork)' : ''}`);
      const user = login.stdout.trim();
      log(`No write access to ${upstream}; publishing through your fork ${user}/${upstream.split('/')[1]}…`);
      const fork = run('gh', ['repo', 'fork', upstream, '--clone=false', '--remote=false'], { cwd: repo });
      if (fork.code !== 0) throw new Error(`fork failed: ${lastLine(fork.stderr)}`);
      run('git', ['remote', 'add', 'fork', `https://github.com/${user}/${upstream.split('/')[1]}.git`], { cwd: repo });
      const push2 = run('git', ['push', '-q', '-u', 'fork', branch], { cwd: repo });
      if (push2.code !== 0) throw new Error(`push to your fork failed: ${lastLine(push2.stderr)}`);
      head = `${user}:${branch}`;
    }
    const title = `${parsed.manifest.name} ${version}`;
    const body = `Publishes \`${id}\` ${version} to \`plugins/${id}\`.\n\n${parsed.manifest.description ?? ''}`.trim();
    // No --base: gh uses the repository's own default branch.
    const pr = run('gh', ['pr', 'create', ...(upstream ? ['--repo', upstream] : []), '--title', title, '--body', body, '--head', head], { cwd: repo });
    if (pr.code === 0 && pr.stdout.trim()) { log(`Pull request: ${pr.stdout.trim()}`); return { id, version, branch, prUrl: pr.stdout.trim(), compareUrl: null }; }
    if (pr.code !== 127 && pr.stderr.trim()) log(`gh could not open the pull request: ${lastLine(pr.stderr)}`);
    const compareUrl = web ? `${web}/compare/${head}?expand=1` : null;
    log(compareUrl ? `Branch pushed. Open the pull request: ${compareUrl}` : `Branch ${branch} pushed; open a pull request.`);
    return { id, version, branch, prUrl: null, compareUrl };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
