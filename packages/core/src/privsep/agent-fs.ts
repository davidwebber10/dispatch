// packages/core/src/privsep/agent-fs.ts
// File changes below the person's home and projects, made AS THE AGENT USER (design section 7).
//
// On a box with privilege separation the daemon is root, and everything below the home is under a
// workload's control: any folder there can be swapped for a link at any moment. A root process that
// writes, renames, deletes or changes the owner of a path there can be led to do it somewhere else
// (the state root, the policy files). Checking the path first does not help: the swap can happen
// between the check and the write.
//
// So the daemon does not make these changes itself. Each function here runs one small script
// through the spawn guard, which gives it the agent's uid: the kernel then applies the agent's own
// rights to every path component, and a planted link can only lead where the agent could already go.
//
// Without privilege separation each function is the plain `fs` call it replaces.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { privsep, type PrivsepConfig } from './config.js';

/**
 * The one script every operation runs (`node -e`, as the agent). argv: the operation, then its
 * arguments. Paths are arguments, never program text. It uses the same `fs` calls the daemon would
 * have made itself, so the behaviour (errors included) is the one callers already expect.
 */
const AGENT_SCRIPT = `
const fs = require('fs');
const [op, a, b, c] = process.argv.slice(1);
const fail = (e) => { process.stderr.write(JSON.stringify({ code: e && e.code || null, message: String(e && e.message || e) })); process.exit(1); };
try {
  if (op === 'mkdir') fs.mkdirSync(a, { recursive: true });
  else if (op === 'rename') fs.renameSync(a, b);
  else if (op === 'unlink') fs.unlinkSync(a);
  else if (op === 'rm') fs.rmSync(a, { recursive: true });
  else if (op === 'write') {
    // The bytes come on stdin; \`b\` is the flag (w, wx, a) and \`c\` the mode of a new file (octal).
    const out = fs.createWriteStream(a, { flags: b, mode: parseInt(c, 8) });
    out.on('error', fail);
    process.stdin.on('error', fail);
    process.stdin.pipe(out);
  } else fail(new Error('unknown operation'));
} catch (e) { fail(e); }
`;

function run(op: string, args: string[], stdin: 'ignore' | number | Buffer | string = 'ignore'): void {
  const input = typeof stdin === 'string' || Buffer.isBuffer(stdin) ? stdin : undefined;
  const r = spawnSync(process.execPath, ['-e', AGENT_SCRIPT, op, ...args], {
    ...(input !== undefined ? { input } : {}),
    stdio: [input !== undefined ? 'pipe' : (stdin as 'ignore' | number), 'ignore', 'pipe'],
    timeout: 300_000,
    maxBuffer: 64 * 1024,
  });
  if (r.error) throw r.error;
  if (r.status !== 0) {
    let info: { code?: string | null; message?: string } = {};
    try { info = JSON.parse(String(r.stderr ?? '')); } catch { info = { message: String(r.stderr ?? '').trim().split('\n').pop() }; }
    const err = new Error(info.message || `the file operation failed (status ${r.status})`) as NodeJS.ErrnoException;
    if (info.code) err.code = info.code;
    throw err;
  }
}

export interface AgentWriteOptions {
  /** Permission bits of a NEW file (default 0644, before the agent's umask). */
  mode?: number;
  /** `wx`: fail when the path exists. `a`: append. Default: replace the content. */
  flag?: 'w' | 'wx' | 'a';
}

/** Write a file below the home as the agent. */
export function agentWriteFile(file: string, data: string | Buffer, opts: AgentWriteOptions = {}, cfg: PrivsepConfig | null = privsep()): void {
  const mode = opts.mode ?? 0o644;
  const flag = opts.flag ?? 'w';
  if (!cfg) { fs.writeFileSync(file, data, { mode, flag }); return; }
  run('write', [file, flag, mode.toString(8)], data);
}

/** Make a folder (and its missing parents) as the agent. */
export function agentMkdir(dir: string, cfg: PrivsepConfig | null = privsep()): void {
  if (!cfg) { fs.mkdirSync(dir, { recursive: true }); return; }
  run('mkdir', [dir]);
}

/**
 * Copy a file the daemon holds (an upload in its own scratch space) to a path below the home. The
 * daemon opens the source (never through a link); the agent-side script only receives the bytes.
 */
export function agentCopyFrom(source: string, dest: string, cfg: PrivsepConfig | null = privsep()): void {
  if (!cfg) { fs.copyFileSync(source, dest); return; }
  const fd = fs.openSync(source, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try { run('write', [dest, 'w', '644'], fd); } finally { fs.closeSync(fd); }
}

/** Rename within the agent's files, as the agent. */
export function agentRename(from: string, to: string, cfg: PrivsepConfig | null = privsep()): void {
  if (!cfg) { fs.renameSync(from, to); return; }
  run('rename', [from, to]);
}

/** Remove a file, a link, or (with `recursive`) a folder, as the agent. A link is removed, not followed. */
export function agentRemove(target: string, opts: { recursive?: boolean } = {}, cfg: PrivsepConfig | null = privsep()): void {
  if (!cfg) { if (opts.recursive) fs.rmSync(target, { recursive: true }); else fs.unlinkSync(target); return; }
  run(opts.recursive ? 'rm' : 'unlink', [target]);
}

/**
 * Run a small Node script as the agent (several steps that must all happen with the agent's rights).
 * The script reads its arguments from `process.argv.slice(1)`.
 */
export function agentNode(script: string, args: string[]): void {
  const r = spawnSync(process.execPath, ['-e', script, ...args], { stdio: ['ignore', 'ignore', 'pipe'], timeout: 60_000 });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(String(r.stderr ?? '').trim().split('\n').pop() || `the script failed (status ${r.status})`);
}
