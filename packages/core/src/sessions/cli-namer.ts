import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { detectProvider, resolveBin, type ProviderName } from '../setup/detect.js';
import { TITLE_SYSTEM_PROMPT, titleUserMessage, cleanTitle } from './model-namer.js';
import { codexHome } from '../platform/codex-home.js';

/**
 * Thread titles from the user's own signed-in harness CLIs, cheapest model first:
 *   1. Claude Code, Claude Haiku 5.5 (`claude -p`)          ~1.7s
 *   2. Codex, Terra (`codex exec`, see CODEX_TITLE_MODELS)   ~4s
 * and only then OpenRouter (model-namer.ts), which needs a key and costs money.
 *
 * Both run the CLI itself, signed in the way a thread is (the daemon's thread env carries
 * Dispatch's saved Claude token), so a title rides the user's subscription. Each call is
 * stripped to the minimum: no tools, no MCP servers, no settings or hooks, no slash
 * commands, low effort, and nothing saved, so a title never shows up as a session in
 * the user's resume list. The prompt goes in on stdin, never argv.
 */

export const CLAUDE_TITLE_MODEL = 'claude-haiku-5-5';
/**
 * Codex title models, most preferred first (the user's pick, 2026-11-05). The first one
 * Codex's own model list offers is used: gpt-6.1-terra is refused on a ChatGPT sign-in
 * today, so this lands on gpt-5.6-terra until the account's list gains 6.1 Terra.
 */
export const CODEX_TITLE_MODELS = ['gpt-6.1-terra', 'gpt-5.6-terra'] as const;
export const CODEX_TITLE_MODEL = CODEX_TITLE_MODELS[CODEX_TITLE_MODELS.length - 1];
/** Codex's model list, under its home ($CODEX_HOME, default ~/.codex). Resolved per call. */
export const codexModelsCachePath = (): string => path.join(codexHome(), 'models_cache.json');

/** The first preferred model Codex lists as available; the last preference when the list can't be read. */
export function pickCodexTitleModel(cachePath: string = codexModelsCachePath()): string {
  try {
    const listed = new Set((JSON.parse(fs.readFileSync(cachePath, 'utf-8')).models ?? [])
      .filter((m: { visibility?: string }) => m?.visibility !== 'hide')
      .map((m: { slug?: string }) => m?.slug));
    return CODEX_TITLE_MODELS.find((m) => listed.has(m)) ?? CODEX_TITLE_MODEL;
  } catch { return CODEX_TITLE_MODEL; }
}

const CLAUDE_TIMEOUT_MS = 10_000;
const CODEX_TIMEOUT_MS = 15_000;

export type TitleGenerator = (conversationText: string) => Promise<string | null>;

export interface RunResult { code: number | null; stdout: string }
/** Runs a command with stdin; resolves (never rejects) once it exits or is killed at the timeout. */
export type CommandRunner = (bin: string, args: string[], opts: { stdin: string; env: Record<string, string>; cwd: string; timeoutMs: number }) => Promise<RunResult>;

export const runCommand: CommandRunner = (bin, args, { stdin, env, cwd, timeoutMs }) => new Promise((resolve) => {
  let stdout = '';
  let done = false;
  const finish = (code: number | null) => { if (!done) { done = true; clearTimeout(timer); resolve({ code, stdout }); } };
  let child: ReturnType<typeof spawn>;
  try { child = spawn(bin, args, { cwd, env, stdio: ['pipe', 'pipe', 'ignore'] }); }
  catch { resolve({ code: null, stdout: '' }); return; }
  const timer = setTimeout(() => { child.kill('SIGKILL'); finish(null); }, timeoutMs);
  timer.unref?.();
  child.stdout?.on('data', (d) => { stdout += d; });
  child.on('error', () => finish(null));
  child.on('close', (code) => finish(code));
  child.stdin?.on('error', () => { /* the CLI exited before reading: close reports it */ });
  child.stdin?.end(stdin);
});

export interface CliNamerDeps {
  /** The env a thread is spawned with (overlaid on the daemon's own), so the CLI signs in as a thread does. */
  env: () => Record<string, string>;
  /** Injectable for tests. */
  run?: CommandRunner;
  /** Injectable for tests: the CLI's path, or null when it is not installed. */
  bin?: (name: ProviderName) => Promise<string | null>;
  /** Injectable for tests: which Codex model to run. */
  codexModel?: () => string;
  /** Injectable for tests: true / 'unknown' tries the CLI, false skips it. */
  signedIn?: (name: ProviderName) => Promise<boolean | 'unknown'>;
}

/** An empty directory to run in, so neither CLI picks up a project's CLAUDE.md / AGENTS.md. */
function scratchDir(): string {
  const dir = path.join(os.tmpdir(), 'dispatch-titles');
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* the spawn reports it */ }
  return dir;
}

async function usable(name: ProviderName, deps: CliNamerDeps): Promise<string | null> {
  const bin = await (deps.bin ?? resolveBin)(name);
  if (!bin) return null;
  const signedIn = await (deps.signedIn ?? (async (n) => (await detectProvider(n)).signedIn))(name).catch(() => 'unknown' as const);
  return signedIn === false ? null : bin;
}

export function claudeTitleGenerator(deps: CliNamerDeps): TitleGenerator {
  return async (conversationText) => {
    const bin = await usable('claude', deps);
    if (!bin) return null;
    const args = [
      '-p', '--model', CLAUDE_TITLE_MODEL, '--system-prompt', TITLE_SYSTEM_PROMPT,
      '--tools', '', '--strict-mcp-config', '--setting-sources', '', '--disable-slash-commands',
      '--no-session-persistence', '--effort', 'low', '--output-format', 'text',
    ];
    const r = await (deps.run ?? runCommand)(bin, args, { stdin: titleUserMessage(conversationText), env: deps.env(), cwd: scratchDir(), timeoutMs: CLAUDE_TIMEOUT_MS });
    return r.code === 0 ? cleanTitle(r.stdout.trim()) : null;
  };
}

export function codexTitleGenerator(deps: CliNamerDeps): TitleGenerator {
  return async (conversationText) => {
    const bin = await usable('codex', deps);
    if (!bin) return null;
    // Codex has no system-prompt flag, so the instruction leads the one message. Its final
    // reply goes to a file (-o): stdout also carries the run log.
    const dir = scratchDir();
    const outFile = path.join(dir, `codex-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
    const args = [
      'exec', '--ephemeral', '--skip-git-repo-check', '--ignore-user-config', '--ignore-rules',
      '-s', 'read-only', '-m', (deps.codexModel ?? pickCodexTitleModel)(), '-c', 'model_reasoning_effort=low', '--color', 'never',
      '-o', outFile, '-',
    ];
    try {
      const r = await (deps.run ?? runCommand)(bin, args, { stdin: `${TITLE_SYSTEM_PROMPT}\n\n${titleUserMessage(conversationText)}`, env: deps.env(), cwd: dir, timeoutMs: CODEX_TIMEOUT_MS });
      if (r.code !== 0) return null;
      return cleanTitle(fs.readFileSync(outFile, 'utf-8').trim());
    } catch { return null; }
    finally { try { fs.rmSync(outFile, { force: true }); } catch { /* best effort */ } }
  };
}

/** Try each generator in order; the first title wins. A throw counts as no title. */
export function firstTitle(generators: TitleGenerator[]): TitleGenerator {
  return async (conversationText) => {
    for (const g of generators) {
      const title = await g(conversationText).catch(() => null);
      if (title) return title;
    }
    return null;
  };
}
