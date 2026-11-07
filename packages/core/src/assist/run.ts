import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { runCommand, usable, scratchDir, pickCodexTitleModel, type CliNamerDeps, type CommandRunner } from '../sessions/cli-namer.js';

/**
 * Model assist (docs/superpowers/specs/2026-11-07-plugins-design.md, section 3.4): one prompt in,
 * text out, with usage, for plugins that judge, summarize or draft. The same signed-in CLIs the
 * thread titles use (`claude -p` JSON output, `codex exec --json`), or the OpenRouter key.
 * No tools, no session, one turn.
 *
 * The caller may choose the harness and the model (coach spec 2026-11-07, section 7.1). An
 * explicit harness runs alone (no fallback); `auto` runs where the most room is (assist-share.ts);
 * no harness keeps the old order: Claude CLI, then OpenRouter.
 */
export interface AssistMessage { role: 'user' | 'assistant'; content: string }
/** Where a call runs: a signed-in CLI, or the OpenRouter key. */
export type AssistHarness = 'claude' | 'codex' | 'openrouter';
export const ASSIST_HARNESSES: readonly AssistHarness[] = ['claude', 'codex', 'openrouter'];
export interface AssistRequest {
  system?: string;
  messages: AssistMessage[];
  maxTokens: number;
  /** One harness only (no fallback); `auto` = the account with the most room; absent = Claude CLI, then OpenRouter. */
  harness?: AssistHarness | 'auto';
  /** The model id for the harness; absent = the harness's small default. */
  model?: string;
  /** The account (accounts.json) a CLI harness signs in as; absent = the harness's default account. */
  accountId?: string;
}
export interface AssistUsage { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreateTokens: number }
export interface AssistResult {
  text: string;
  /** `inputTokens` is the uncached input; the cache reads and writes are kept apart. */
  usage: AssistUsage;
  ms: number;
  model: string;
  harness: AssistHarness;
  /** The account the call ran on; null for OpenRouter. */
  accountId: string | null;
  /** The cost the harness reported, else null (the route prices it from the tokens). */
  costUsd: number | null;
}
/** What `auto` resolved to, and why (assist-share.ts pickHarness). */
export interface AssistPick { harness: AssistHarness; accountId: string; reason: string }
export interface AssistRunner {
  /** Whether a model can answer right now: any (a signed-in CLI, or a key), or the one harness asked for. */
  available(harness?: AssistHarness | 'auto'): Promise<boolean>;
  /** The answer, or null when the model gave none. */
  run(req: AssistRequest): Promise<AssistResult | null>;
}

export const ASSIST_CLAUDE_MODEL = 'claude-haiku-5-5';
export const ASSIST_OPENROUTER_MODEL = 'anthropic/claude-haiku-5.5';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const CLAUDE_TIMEOUT_MS = 60_000;
const CODEX_TIMEOUT_MS = 90_000;
const OPENROUTER_TIMEOUT_MS = 60_000;

const num = (x: unknown): number => (typeof x === 'number' && Number.isFinite(x) ? x : 0);
const zeroUsage = (): AssistUsage => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 });

/** The messages as one transcript for a CLI that takes a single prompt. */
export function transcriptOf(messages: AssistMessage[]): string {
  if (messages.length === 1 && messages[0].role === 'user') return messages[0].content;
  return messages.map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`).join('\n\n');
}

/** Parse `claude -p --output-format json` output into a result; null when it is not a result. */
export function parseClaudeJson(stdout: string, ms: number): AssistResult | null {
  // The CLI may print one JSON object, or several lines of them; the result is the last one with a `result`.
  const lines = stdout.trim().split('\n').map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    let v: Record<string, unknown>;
    try { v = JSON.parse(lines[i]) as Record<string, unknown>; } catch { continue; }
    if (typeof v.result !== 'string') continue;
    if (v.is_error === true) return null;
    const u = (v.usage ?? {}) as Record<string, unknown>;
    return {
      text: v.result,
      usage: { inputTokens: num(u.input_tokens), outputTokens: num(u.output_tokens), cacheReadTokens: num(u.cache_read_input_tokens), cacheCreateTokens: num(u.cache_creation_input_tokens) },
      ms: typeof v.duration_ms === 'number' ? v.duration_ms : ms,
      model: typeof v.model === 'string' ? v.model : ASSIST_CLAUDE_MODEL,
      harness: 'claude',
      accountId: null,
      costUsd: typeof v.total_cost_usd === 'number' && Number.isFinite(v.total_cost_usd) ? v.total_cost_usd : null,
    };
  }
  return null;
}

/**
 * The usage of a `codex exec --json` run: the last `turn.completed` event's usage. Codex counts
 * cached input inside `input_tokens` (OpenAI's convention), so the cached part is taken out.
 */
export function parseCodexUsage(stdout: string): AssistUsage {
  let usage = zeroUsage();
  for (const line of stdout.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    let v: { type?: unknown; usage?: Record<string, unknown> };
    try { v = JSON.parse(t); } catch { continue; }
    if (v.type !== 'turn.completed' || !v.usage) continue;
    const cached = num(v.usage.cached_input_tokens);
    usage = { inputTokens: Math.max(0, num(v.usage.input_tokens) - cached), outputTokens: num(v.usage.output_tokens), cacheReadTokens: cached, cacheCreateTokens: 0 };
  }
  return usage;
}

export interface AssistRunnerDeps {
  cli: CliNamerDeps;
  getApiKey?: () => Promise<string | null>;
  run?: CommandRunner;
  fetchImpl?: typeof fetch;
  /** The env overlay that signs a CLI in as one account (AccountsStore.spawnEnv). */
  accountEnv?: (harness: 'claude' | 'codex', accountId: string) => Record<string, string>;
  /** The harness's default account; `cli` when absent. */
  defaultAccount?: (harness: 'claude' | 'codex') => string;
  /** What `auto` runs on (assist-share.ts pickHarness); null = nothing signed in. Absent: `auto` keeps the old order. */
  pickAuto?: () => Promise<AssistPick | null>;
}

export function createAssistRunner(deps: AssistRunnerDeps): AssistRunner {
  const run = deps.run ?? deps.cli.run ?? runCommand;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const accountOf = (h: 'claude' | 'codex', req: AssistRequest): string => req.accountId ?? deps.defaultAccount?.(h) ?? 'cli';
  const envFor = (h: 'claude' | 'codex', accountId: string): Record<string, string> => ({ ...deps.cli.env(), ...(deps.accountEnv?.(h, accountId) ?? {}) });

  async function viaClaude(req: AssistRequest): Promise<AssistResult | null> {
    const bin = await usable('claude', deps.cli);
    if (!bin) return null;
    const accountId = accountOf('claude', req);
    const args = [
      '-p', '--model', req.model ?? ASSIST_CLAUDE_MODEL,
      ...(req.system ? ['--system-prompt', req.system] : []),
      '--tools', '', '--strict-mcp-config', '--setting-sources', '', '--disable-slash-commands',
      '--no-session-persistence', '--max-turns', '1', '--output-format', 'json',
    ];
    const started = Date.now();
    const r = await run(bin, args, { stdin: transcriptOf(req.messages), env: envFor('claude', accountId), cwd: scratchDir(), timeoutMs: CLAUDE_TIMEOUT_MS });
    if (r.code !== 0) return null;
    const out = parseClaudeJson(r.stdout, Date.now() - started);
    return out ? { ...out, accountId } : null;
  }

  /** Codex: `codex exec`, stripped as the namer's is (cli-namer.ts); the answer goes to a file, the usage comes from --json. */
  async function viaCodex(req: AssistRequest): Promise<AssistResult | null> {
    const bin = await usable('codex', deps.cli);
    if (!bin) return null;
    const accountId = accountOf('codex', req);
    const model = req.model ?? (deps.cli.codexModel ?? pickCodexTitleModel)();
    const dir = scratchDir();
    const outFile = path.join(dir, `assist-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
    const args = [
      'exec', '--json', '--ephemeral', '--skip-git-repo-check', '--ignore-user-config', '--ignore-rules',
      '-s', 'read-only', '-m', model, '-c', 'model_reasoning_effort=low', '--color', 'never',
      '-o', outFile, '-',
    ];
    // Codex has no system-prompt flag: the instruction leads the one message (as the namer does).
    const stdin = req.system ? `${req.system}\n\n${transcriptOf(req.messages)}` : transcriptOf(req.messages);
    const started = Date.now();
    try {
      const r = await run(bin, args, { stdin, env: envFor('codex', accountId), cwd: dir, timeoutMs: CODEX_TIMEOUT_MS });
      if (r.code !== 0) return null;
      const text = fs.readFileSync(outFile, 'utf-8').trim();
      if (!text) return null;
      return { text, usage: parseCodexUsage(r.stdout), ms: Date.now() - started, model, harness: 'codex', accountId, costUsd: null };
    } catch { return null; }
    finally { try { fs.rmSync(outFile, { force: true }); } catch { /* best effort */ } }
  }

  async function viaOpenRouter(req: AssistRequest): Promise<AssistResult | null> {
    const key = await deps.getApiKey?.().catch(() => null);
    if (!key) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), OPENROUTER_TIMEOUT_MS);
    timer.unref?.();
    const started = Date.now();
    try {
      const res = await fetchImpl(OPENROUTER_URL, {
        method: 'POST', signal: controller.signal,
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: req.model ?? ASSIST_OPENROUTER_MODEL, max_tokens: req.maxTokens, temperature: 0.2, messages: [...(req.system ? [{ role: 'system', content: req.system }] : []), ...req.messages] }),
      });
      if (!res.ok) return null;
      const data = (await res.json()) as { choices?: { message?: { content?: unknown } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number; prompt_tokens_details?: { cached_tokens?: number } }; model?: string };
      const text = data.choices?.[0]?.message?.content;
      if (typeof text !== 'string') return null;
      const cached = num(data.usage?.prompt_tokens_details?.cached_tokens);
      return {
        text,
        usage: { inputTokens: Math.max(0, num(data.usage?.prompt_tokens) - cached), outputTokens: num(data.usage?.completion_tokens), cacheReadTokens: cached, cacheCreateTokens: 0 },
        ms: Date.now() - started,
        model: data.model ?? req.model ?? ASSIST_OPENROUTER_MODEL,
        harness: 'openrouter',
        accountId: null,
        costUsd: typeof data.usage?.cost === 'number' && Number.isFinite(data.usage.cost) ? data.usage.cost : null,
      };
    } catch { return null; }
    finally { clearTimeout(timer); }
  }

  const hasKey = async () => !!(await deps.getApiKey?.().catch(() => null));
  const one = (h: AssistHarness, req: AssistRequest) => (h === 'claude' ? viaClaude(req) : h === 'codex' ? viaCodex(req) : viaOpenRouter(req));

  return {
    available: async (harness) => {
      if (harness === 'claude' || harness === 'codex') return (await usable(harness, deps.cli)) !== null;
      if (harness === 'openrouter') return hasKey();
      if (harness === 'auto' && deps.pickAuto) return (await deps.pickAuto().catch(() => null)) !== null;
      return (await usable('claude', deps.cli)) !== null || hasKey();
    },
    run: async (req) => {
      if (req.harness === 'auto' && deps.pickAuto) {
        const pick = await deps.pickAuto().catch(() => null);
        if (!pick) return null;
        // `auto` chooses the harness and the account; a model id asked for still applies.
        return one(pick.harness, { ...req, harness: pick.harness, accountId: pick.harness === 'openrouter' ? undefined : pick.accountId });
      }
      if (req.harness && req.harness !== 'auto') return one(req.harness, req);
      return (await viaClaude(req)) ?? (await viaOpenRouter(req));
    },
  };
}

/**
 * A test seam (`DISPATCH_ASSIST_COMMAND`): a shell command that reads the request as JSON on
 * stdin and writes the result as JSON on stdout. Lets an end-to-end run use a fake model.
 */
export function commandAssistRunner(command: string, timeoutMs = 30_000): AssistRunner {
  return {
    available: async () => true,
    run: (req) => new Promise((resolve) => {
      const started = Date.now();
      let out = ''; let done = false;
      const finish = (v: AssistResult | null) => { if (!done) { done = true; clearTimeout(timer); resolve(v); } };
      let child: ReturnType<typeof spawn>;
      try { child = spawn(command, { shell: true, stdio: ['pipe', 'pipe', 'ignore'] }); } catch { resolve(null); return; }
      const ee = child as unknown as NodeJS.EventEmitter;
      const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } finish(null); }, timeoutMs);
      child.stdout?.on('data', (d) => { out += String(d); });
      ee.on('error', () => finish(null));
      ee.on('close', (code: number | null) => {
        if (code !== 0) return finish(null);
        try {
          const v = JSON.parse(out) as Partial<Omit<AssistResult, 'usage'>> & { usage?: Partial<AssistUsage> };
          if (typeof v.text !== 'string') return finish(null);
          const explicit = req.harness && req.harness !== 'auto' ? req.harness : null;
          finish({
            text: v.text,
            usage: { inputTokens: num(v.usage?.inputTokens), outputTokens: num(v.usage?.outputTokens), cacheReadTokens: num(v.usage?.cacheReadTokens), cacheCreateTokens: num(v.usage?.cacheCreateTokens) },
            ms: typeof v.ms === 'number' ? v.ms : Date.now() - started,
            model: v.model ?? req.model ?? 'command',
            harness: explicit ?? v.harness ?? 'claude',
            accountId: v.accountId ?? req.accountId ?? null,
            costUsd: typeof v.costUsd === 'number' ? v.costUsd : null,
          });
        } catch { finish(null); }
      });
      child.stdin?.on('error', () => { /* the command closed stdin early */ });
      child.stdin?.end(JSON.stringify(req));
    }),
  };
}
