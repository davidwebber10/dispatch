/**
 * Hands Claude Code its appended system prompt in a private file instead of command-line text,
 * when the installed Claude supports it. A prompt in argv shows in `ps` (and in any process log),
 * and a broad pattern such as `pkill -f until` matched every agent whose prompt holds the word
 * (2026-10-12: 14 agent threads stopped at once). Claude Code's own self-hosted runners moved to
 * prompt files too (CHANGELOG 2.1.281), because long prompts failed the launch.
 *
 * Version gate (Claude Code CHANGELOG): `--append-system-prompt-file` works in interactive mode as
 * well as `-p` from 2.1.69; before 2.1.283 the text and file forms could not be combined, so all
 * the parts go into ONE file. Older or unknown Claude keeps the text form, unchanged.
 */
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { platform } from '../platform/index.js';
import { inheritedEnv } from '../platform/inherited-env.js';

type Version = [number, number, number];

const MIN_VERSION: Version = [2, 1, 69];
/** How long a version read stays good before the next spawn refreshes it in the background. */
const VERSION_TTL_MS = 60 * 60 * 1000;
/** A prompt file not written or reused for this long is deleted. */
const PROMPT_FILE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export function parseClaudeVersion(output: string): Version | null {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(output);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function supportsPromptFile(v: Version): boolean {
  for (let i = 0; i < 3; i++) if (v[i] !== MIN_VERSION[i]) return v[i] > MIN_VERSION[i];
  return true;
}

let known: { supported: boolean; at: number } | null = null;
let reading: Promise<void> | null = null;
/**
 * The env agents are spawned with: its PATH puts Dispatch's own bin dirs first. It is an overlay
 * that the thread managers spread over inheritedEnv(), so the probe spreads it the same way.
 */
let probeEnv: Record<string, string> | undefined;

/**
 * Read the version from the `claude` the agents will run: the first on THEIR PATH, which can be a
 * different install than the daemon's own (e.g. one under ~/.dispatch/tools). A PATH change
 * re-reads it.
 */
export function setClaudeProbeEnv(env: Record<string, string>): void {
  const changed = probeEnv?.PATH !== env.PATH;
  probeEnv = env;
  if (changed && known) void warmClaudeVersion().then(() => prunePromptFiles());
}

function claudeVersionOutput(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('claude', ['--version'], { timeout: 15_000, env: { ...inheritedEnv(), ...probeEnv } }, (err, stdout) => (err ? reject(err) : resolve(String(stdout))));
  });
}

/**
 * Read the installed Claude Code version (server boot, then hourly in the background). The spawn
 * path is synchronous and only reads the result; until a read lands it uses the text form.
 */
export function warmClaudeVersion(read: () => Promise<string> = claudeVersionOutput): Promise<void> {
  if (reading) return reading;
  reading = (async () => {
    try {
      const v = parseClaudeVersion(await read());
      known = { supported: v !== null && supportsPromptFile(v), at: Date.now() };
    } catch {
      known = { supported: false, at: Date.now() };
    } finally {
      reading = null;
    }
  })();
  return reading;
}

/** Whether to use the file form now. Never blocks; a stale read is refreshed in the background. */
export function claudePromptFileSupported(now = Date.now()): boolean {
  if (known && now - known.at > VERSION_TTL_MS) void warmClaudeVersion().then(() => prunePromptFiles());
  return known?.supported ?? false;
}

export function resetClaudeVersionForTests(): void {
  known = null;
  reading = null;
  probeEnv = undefined;
}

function promptDir(): string {
  return path.join(platform.dataDir(), 'prompts');
}

/**
 * Write `text` to a private file named by its hash and return the path. The same text maps to the
 * same file; reusing it marks it as used, so pruning keeps it. Written whole, then renamed in, so a
 * starting Claude never reads half a prompt.
 */
export function writePromptFile(dir: string, text: string): string {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const file = path.join(dir, `${createHash('sha256').update(text).digest('hex').slice(0, 32)}.md`);
  if (fs.existsSync(file)) {
    const now = new Date();
    fs.utimesSync(file, now, now);
    return file;
  }
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, file);
  return file;
}

/** Delete prompt files not written or reused for a week. Best effort. */
export function prunePromptFiles(dir: string = promptDir(), now = Date.now()): void {
  let names: string[];
  try { names = fs.readdirSync(dir); } catch { return; }
  for (const name of names) {
    const file = path.join(dir, name);
    try { if (now - fs.statSync(file).mtimeMs > PROMPT_FILE_MAX_AGE_MS) fs.unlinkSync(file); } catch { /* gone or busy */ }
  }
}

/**
 * The args that append `parts` (empty ones skipped) to Claude's system prompt: one
 * `--append-system-prompt-file` when the installed Claude supports it, else one
 * `--append-system-prompt <text>` per part, as before. A file that cannot be written falls back
 * to the text form.
 */
export function appendSystemPromptArgs(
  parts: (string | null | undefined)[],
  opts: { dir?: string; supported?: boolean } = {},
): string[] {
  const texts = parts.filter((p): p is string => typeof p === 'string' && p.trim() !== '');
  if (texts.length === 0) return [];
  if (opts.supported ?? claudePromptFileSupported()) {
    try {
      return ['--append-system-prompt-file', writePromptFile(opts.dir ?? promptDir(), texts.join('\n\n'))];
    } catch { /* fall back to the text form below */ }
  }
  return texts.flatMap((t) => ['--append-system-prompt', t]);
}
