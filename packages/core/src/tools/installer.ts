// packages/core/src/tools/installer.ts
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, execSync } from 'node:child_process';
import { toolPaths, hostPlatformKey, hostOsFamily, type ToolPaths } from './paths.js';
import type { ToolEntry } from './types.js';
import { loadManifest, loadBundledManifest } from './manifest.js';

export type Downloader = (url: string) => Promise<Buffer>;
export type Exec = (cmd: string, args: string[], opts?: { env?: Record<string, string>; cwd?: string }) => void;

const defaultDownload: Downloader = async (url) => {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`download ${url} failed: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
};
const defaultExec: Exec = (cmd, args, opts) => { execFileSync(cmd, args, { stdio: 'inherit', env: { ...process.env, ...opts?.env }, cwd: opts?.cwd }); };

export function readInstalled(base?: string): Record<string, { version?: string; sha?: string; script?: string }> {
  try { return JSON.parse(fs.readFileSync(toolPaths(base).installed, 'utf8')); } catch { return {}; }
}
function writeInstalled(p: ToolPaths, data: Record<string, { version?: string; sha?: string; script?: string }>): void {
  fs.mkdirSync(p.dir, { recursive: true });
  fs.writeFileSync(p.installed, JSON.stringify(data, null, 2));
}

function ensureDirs(p: ToolPaths): void { for (const d of [p.dir, p.bin, p.cache, p.pkgs]) fs.mkdirSync(d, { recursive: true }); }

export async function installTool(entry: ToolEntry, opts: { base?: string; download?: Downloader; exec?: Exec }): Promise<void> {
  if (entry.platforms && !entry.platforms.includes(hostOsFamily())) {
    throw new Error(`${entry.name}: not supported on ${hostOsFamily()} (supports: ${entry.platforms.join(', ')})`);
  }
  const p = toolPaths(opts.base);
  const download = opts.download ?? defaultDownload;
  const exec = opts.exec ?? defaultExec;
  ensureDirs(p);
  const installed = readInstalled(opts.base);

  if (entry.kind === 'binary') {
    const asset = entry.binary?.[hostPlatformKey()];
    if (!asset) throw new Error(`${entry.name}: no asset for ${hostPlatformKey()}`);
    const key = asset.url + (asset.sha256 ?? '');
    if (installed[entry.name]?.sha === key && fs.existsSync(path.join(p.bin, entry.bins[0]))) return; // idempotent
    const buf = await download(asset.url);
    if (asset.sha256) {
      const got = crypto.createHash('sha256').update(buf).digest('hex');
      if (got !== asset.sha256) throw new Error(`${entry.name}: sha256 mismatch (got ${got})`);
    }
    if ((asset.archive ?? 'none') === 'none') {
      const dest = path.join(p.bin, entry.bins[0]);
      fs.writeFileSync(dest, buf); fs.chmodSync(dest, 0o755);
    } else {
      const work = fs.mkdtempSync(path.join(p.cache, 'x-'));
      try {
        const arc = path.join(work, asset.archive === 'zip' ? 'a.zip' : 'a.tgz');
        fs.writeFileSync(arc, buf);
        if (asset.archive === 'zip') exec('unzip', ['-oq', arc, '-d', work]);
        else exec('tar', ['-xzf', arc, '-C', work]);
        const from = path.join(work, asset.binPath ?? entry.bins[0]);
        const dest = path.join(p.bin, entry.bins[0]);
        fs.copyFileSync(from, dest); fs.chmodSync(dest, 0o755);
      } finally {
        fs.rmSync(work, { recursive: true, force: true });
      }
    }
    installed[entry.name] = { sha: key };
    writeInstalled(p, installed);
    return;
  }

  if (entry.kind === 'npm') {
    if (!entry.npm) throw new Error(`${entry.name}: missing npm spec`);
    const spec = `${entry.npm.package}@${entry.npm.version ?? 'latest'}`;
    if (installed[entry.name]?.version === spec && fs.existsSync(path.join(p.bin, entry.bins[0]))) return;
    exec('npm', ['i', '--prefix', p.pkgs, spec]);
    for (const b of entry.bins) {
      const src = path.join(p.pkgs, 'node_modules', '.bin', b);
      const dest = path.join(p.bin, b);
      try { fs.rmSync(dest, { force: true }); } catch { /* ignore */ }
      fs.symlinkSync(src, dest);
    }
    installed[entry.name] = { version: spec };
    writeInstalled(p, installed);
    return;
  }

  // script
  if (!entry.script) throw new Error(`${entry.name}: missing script spec`);
  // Bins that exist prove little (the old aws recipe left a link whose payload $TMPDIR purged), so
  // skip only when the recorded recipe fingerprint matches; a changed recipe reinstalls.
  const recipe = entry.script.install;
  const fingerprint = crypto.createHash('sha256').update(recipe).digest('hex');
  const record = installed[entry.name];
  const binsPresent = entry.bins.every((b) => fs.existsSync(path.join(p.bin, b)));
  if (record?.script === fingerprint && binsPresent) return;
  // A legacy `{}` record (from before fingerprints) with its bins present reruns only a bundled
  // recipe; a user recipe is adopted as-is, since rerunning one that is not idempotent fails every update.
  if (record && record.script === undefined && binsPresent
    && !loadBundledManifest().some((d) => d.name === entry.name && d.script?.install === recipe)) {
    installed[entry.name] = { script: fingerprint };
    writeInstalled(p, installed);
    return;
  }
  execSync(recipe, { stdio: 'inherit', env: { ...process.env, TOOLS_PREFIX: p.dir, TOOLS_BIN: p.bin } });
  for (const b of entry.bins) if (!fs.existsSync(path.join(p.bin, b))) throw new Error(`${entry.name}: script did not produce ${b}`);
  installed[entry.name] = { script: fingerprint };
  writeInstalled(p, installed);
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false; // 0 and negatives would signal a process group
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

// The lock a script recipe takes (the aws recipe: opt/.aws.lock holding its shell's pid). mkdir is
// atomic; a lock whose owner is gone is taken over, once.
function takeToolLock(lock: string): boolean {
  for (let attempt = 0; attempt < 2; attempt++) {
    try { fs.mkdirSync(lock); fs.writeFileSync(path.join(lock, 'pid'), String(process.pid)); return true; }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
    let pid = NaN;
    try { pid = Number(fs.readFileSync(path.join(lock, 'pid'), 'utf8').trim()); } catch { /* no pid yet */ }
    if (pidAlive(pid)) return false;
    fs.rmSync(lock, { recursive: true, force: true });
  }
  return false;
}
function releaseToolLock(lock: string): void {
  try { if (fs.readFileSync(path.join(lock, 'pid'), 'utf8').trim() === String(process.pid)) fs.rmSync(lock, { recursive: true, force: true }); }
  catch { /* not ours */ }
}

export function uninstallTool(name: string, base?: string): void {
  const p = toolPaths(base);
  const installed = readInstalled(base);
  const entry = loadManifest(base).find((e) => e.name === name);
  // A script recipe's payload lives in opt/<name>; drop it and every bin link into it, which also
  // catches extras the recipe linked beyond entry.bins (aws_completer), plus any opt/.<name>-stage.*
  // dir a killed install left. Only for a plain name: `..` or `a/b` would aim the recursive rm
  // outside opt/. Hold the recipe's lock throughout, so an install in flight keeps its payload.
  const opt = path.join(p.opt, name);
  const plain = path.dirname(opt) === p.opt;
  const lock = path.join(p.opt, `.${name}.lock`);
  if (plain) {
    fs.mkdirSync(p.opt, { recursive: true });
    if (!takeToolLock(lock)) throw new Error(`${name}: an install is running; try again when it ends`);
  }
  try {
    for (const b of (entry?.bins ?? [name])) {
      try { fs.rmSync(path.join(p.bin, b), { force: true }); } catch { /* ignore */ }
    }
    if (plain) {
      let links: string[] = [];
      try { links = fs.readdirSync(p.bin); } catch { /* no bin dir */ }
      for (const f of links) {
        const link = path.join(p.bin, f);
        try {
          if (!fs.lstatSync(link).isSymbolicLink()) continue;
          const target = path.resolve(p.bin, fs.readlinkSync(link));
          if (target === opt || target.startsWith(opt + path.sep)) fs.rmSync(link, { force: true });
        } catch { /* ignore */ }
      }
      fs.rmSync(opt, { recursive: true, force: true });
      const staged = fs.readdirSync(p.opt).filter((f) => f.startsWith(`.${name}-stage.`));
      for (const f of staged) fs.rmSync(path.join(p.opt, f), { recursive: true, force: true });
    }
    delete installed[name];
    writeInstalled(p, installed);
  } finally {
    if (plain) releaseToolLock(lock);
  }
}
