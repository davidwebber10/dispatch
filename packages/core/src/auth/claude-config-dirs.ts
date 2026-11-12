// packages/core/src/auth/claude-config-dirs.ts
// One CLAUDE_CONFIG_DIR per added Claude account on a hosted box (the clean login).
//
// Claude Code keeps EVERYTHING per config dir: its credential, `.claude.json` (the account), settings,
// skills, plugins, and `projects/<cwd>/<session>.jsonl` (the conversations). Measured 2026-11-11: a
// session started under one config dir cannot be resumed under another ("No conversation found")
// unless `projects/` is shared; with `projects` a symlink to the first dir's, it is found.
//
// So an added account's dir holds its OWN credential and `.claude.json`, and SHARES (symlinks to the
// primary dir) what a thread needs to carry on under another account:
//   projects/       — the conversations: resume under any account (the measured requirement)
//   skills/, commands/, agents/, plugins/ — the person's own extensions, the same on every account
//   settings.json, CLAUDE.md                — the person's own settings and memory
// Never shared: .credentials.json, .claude.json (who is signed in), statsig/, todos/, shell-snapshots/.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { privsep } from '../privsep/config.js';
import { agentDirFor } from '../privsep/paths.js';
import { agentNode } from '../privsep/agent-fs.js';

export const SHARED_DIRS = ['projects', 'skills', 'commands', 'agents', 'plugins'] as const;
export const SHARED_FILES = ['settings.json', 'CLAUDE.md'] as const;

/** The primary config dir: CLAUDE_CONFIG_DIR of the daemon, else ~/.claude. */
export function primaryClaudeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_CONFIG_DIR?.trim() || path.join(os.homedir(), '.claude');
}

/** `<dataDir>/claude-accounts/<id>`. The id is a short id the store makes; anything else is refused. */
export function accountConfigDir(dataDir: string, id: string): string {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new Error('bad account id');
  return path.join(agentDirFor(dataDir, 'claude-accounts'), id);
}

/**
 * Make (or repair) an added account's config dir, with the shared parts linked to the primary dir.
 * The primary's directories are created when missing, so a link never dangles. A real file or folder
 * already in the account dir under a shared name is left as it is (never deleted).
 */
export function prepareAccountConfigDir(dataDir: string, id: string, primary: string = primaryClaudeConfigDir()): string {
  const dir = accountConfigDir(dataDir, id);
  if (privsep()) {
    // Privilege separation: both folders are the agent's, so every step runs as the agent (the same
    // steps as below, in one small script). The daemon itself creates nothing and links nothing here.
    agentNode(PREPARE_AS_AGENT, [dir, primary, JSON.stringify(SHARED_DIRS), JSON.stringify(SHARED_FILES)]);
    return dir;
  }
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(primary, { recursive: true, mode: 0o700 });
  const link = (name: string, isDir: boolean) => {
    const target = path.join(primary, name);
    if (isDir) fs.mkdirSync(target, { recursive: true });
    else if (!fs.existsSync(target)) return; // a file the primary does not have: nothing to share
    const at = path.join(dir, name);
    try {
      const st = fs.lstatSync(at);
      if (!st.isSymbolicLink()) return;
      if (fs.readlinkSync(at) === target) return;
      fs.unlinkSync(at);
    } catch { /* missing: make it */ }
    fs.symlinkSync(target, at, isDir ? 'dir' : 'file');
  };
  for (const d of SHARED_DIRS) link(d, true);
  for (const f of SHARED_FILES) link(f, false);
  return dir;
}

/** `prepareAccountConfigDir`, for `node -e` as the agent: argv = dir, primary, shared dirs (JSON), shared files (JSON). */
const PREPARE_AS_AGENT = `
const fs = require('fs'), path = require('path');
const [dir, primary, dirs, files] = process.argv.slice(1);
fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
fs.mkdirSync(primary, { recursive: true, mode: 0o700 });
const link = (name, isDir) => {
  const target = path.join(primary, name);
  if (isDir) fs.mkdirSync(target, { recursive: true });
  else if (!fs.existsSync(target)) return;
  const at = path.join(dir, name);
  try {
    const st = fs.lstatSync(at);
    if (!st.isSymbolicLink()) return;
    if (fs.readlinkSync(at) === target) return;
    fs.unlinkSync(at);
  } catch {}
  fs.symlinkSync(target, at, isDir ? 'dir' : 'file');
};
for (const d of JSON.parse(dirs)) link(d, true);
for (const f of JSON.parse(files)) link(f, false);
`;
