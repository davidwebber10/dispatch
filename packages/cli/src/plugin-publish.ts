import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { parseManifest, isMarketplaceUrl, compareVersions } from 'dispatch-server/plugins';

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
const lastLine = (s: string): string => s.split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? 'failed';

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

/** Copy a plugin folder: regular files and folders only; no node_modules, no install record, no symlinks. */
function copyPlugin(from: string, to: string): void {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.dispatch-install.json' || e.name === '.git') continue;
    if (e.isSymbolicLink()) continue;
    const src = path.join(from, e.name); const dest = path.join(to, e.name);
    if (e.isDirectory()) copyPlugin(src, dest);
    else if (e.isFile()) fs.copyFileSync(src, dest);
  }
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
  const url = resolveMarketplace(o.marketplace, o.dataDir);
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
    copyPlugin(folder, dest);
    run('git', ['add', '-A', '--', `plugins/${id}`], { cwd: repo });
    const commit = run('git', ['-c', 'user.name=dispatch plugin publish', '-c', 'user.email=dispatch@localhost', 'commit', '-q', '-m', `plugins: ${id} ${version}`], { cwd: repo });
    if (commit.code !== 0) throw new Error(`nothing to publish: ${lastLine(commit.stderr) || 'the marketplace already has these files'}`);
    if (o.dryRun) { log(`Dry run: ${branch} is ready in ${repo} (not pushed).`); return { id, version, branch, prUrl: null, compareUrl: null }; }
    log(`Pushing ${branch}…`);
    const push = run('git', ['push', '-q', '-u', 'origin', branch], { cwd: repo });
    if (push.code !== 0) throw new Error(`push failed: ${lastLine(push.stderr)}`);
    const web = githubWebUrl(url) ?? (o.githubUrlFor ? githubWebUrl(o.githubUrlFor(url) ?? '') : null);
    const title = `${parsed.manifest.name} ${version}`;
    const body = `Publishes \`${id}\` ${version} to \`plugins/${id}\`.\n\n${parsed.manifest.description ?? ''}`.trim();
    const pr = run('gh', ['pr', 'create', '--title', title, '--body', body, '--head', branch, '--base', 'main'], { cwd: repo });
    if (pr.code === 0 && pr.stdout.trim()) { log(`Pull request: ${pr.stdout.trim()}`); return { id, version, branch, prUrl: pr.stdout.trim(), compareUrl: null }; }
    const compareUrl = web ? `${web}/compare/${branch}?expand=1` : null;
    log(compareUrl ? `Branch pushed. Open the pull request: ${compareUrl}` : `Branch ${branch} pushed; open a pull request against main.`);
    return { id, version, branch, prUrl: null, compareUrl };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
