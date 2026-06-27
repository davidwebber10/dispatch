// packages/core/src/tools/installer.ts
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, execSync } from 'node:child_process';
import { toolPaths, hostPlatformKey, type ToolPaths } from './paths.js';
import type { ToolEntry } from './types.js';

export type Downloader = (url: string) => Promise<Buffer>;
export type Exec = (cmd: string, args: string[], opts?: { env?: Record<string, string>; cwd?: string }) => void;

const defaultDownload: Downloader = async (url) => {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`download ${url} failed: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
};
const defaultExec: Exec = (cmd, args, opts) => { execFileSync(cmd, args, { stdio: 'inherit', env: { ...process.env, ...opts?.env }, cwd: opts?.cwd }); };

export function readInstalled(base?: string): Record<string, { version?: string; sha?: string }> {
  try { return JSON.parse(fs.readFileSync(toolPaths(base).installed, 'utf8')); } catch { return {}; }
}
function writeInstalled(p: ToolPaths, data: Record<string, { version?: string; sha?: string }>): void {
  fs.mkdirSync(p.dir, { recursive: true });
  fs.writeFileSync(p.installed, JSON.stringify(data, null, 2));
}

function ensureDirs(p: ToolPaths): void { for (const d of [p.dir, p.bin, p.cache, p.pkgs]) fs.mkdirSync(d, { recursive: true }); }

export async function installTool(entry: ToolEntry, opts: { base?: string; download?: Downloader; exec?: Exec }): Promise<void> {
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
      const arc = path.join(work, asset.archive === 'zip' ? 'a.zip' : 'a.tgz');
      fs.writeFileSync(arc, buf);
      if (asset.archive === 'zip') exec('unzip', ['-oq', arc, '-d', work]);
      else exec('tar', ['-xzf', arc, '-C', work]);
      const from = path.join(work, asset.binPath ?? entry.bins[0]);
      const dest = path.join(p.bin, entry.bins[0]);
      fs.copyFileSync(from, dest); fs.chmodSync(dest, 0o755);
      fs.rmSync(work, { recursive: true, force: true });
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
  execSync(entry.script.install, { stdio: 'inherit', env: { ...process.env, TOOLS_PREFIX: p.dir, TOOLS_BIN: p.bin } });
  for (const b of entry.bins) if (!fs.existsSync(path.join(p.bin, b))) throw new Error(`${entry.name}: script did not produce ${b}`);
  installed[entry.name] = {};
  writeInstalled(p, installed);
}

export function uninstallTool(name: string, base?: string): void {
  const p = toolPaths(base);
  const installed = readInstalled(base);
  const f = path.join(p.bin, name);
  try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
  delete installed[name];
  writeInstalled(p, installed);
}
