import { runCommand, usable, scratchDir, type CliNamerDeps, type CommandRunner } from '../sessions/cli-namer.js';

/**
 * Model assist (docs/superpowers/specs/2026-11-07-plugins-design.md, section 3.4): one prompt in,
 * text out, with usage, for plugins that judge, summarise or draft. The same signed-in CLI the
 * thread titles use (`claude -p`, JSON output), else the OpenRouter key the namer falls back to.
 * No tools, no session, one turn.
 */
export interface AssistMessage { role: 'user' | 'assistant'; content: string }
export interface AssistRequest { system?: string; messages: AssistMessage[]; maxTokens: number }
export interface AssistResult { text: string; usage: { inputTokens: number; outputTokens: number }; ms: number; model: string }
export interface AssistRunner {
  /** Whether any model can answer right now (a signed-in CLI, or a key). */
  available(): Promise<boolean>;
  /** The answer, or null when the model gave none. */
  run(req: AssistRequest): Promise<AssistResult | null>;
}

export const ASSIST_CLAUDE_MODEL = 'claude-haiku-5-5';
export const ASSIST_OPENROUTER_MODEL = 'anthropic/claude-haiku-5.5';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const CLAUDE_TIMEOUT_MS = 60_000;
const OPENROUTER_TIMEOUT_MS = 60_000;

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
    const n = (x: unknown) => (typeof x === 'number' ? x : 0);
    return {
      text: v.result,
      usage: { inputTokens: n(u.input_tokens) + n(u.cache_read_input_tokens) + n(u.cache_creation_input_tokens), outputTokens: n(u.output_tokens) },
      ms: typeof v.duration_ms === 'number' ? v.duration_ms : ms,
      model: typeof v.model === 'string' ? v.model : ASSIST_CLAUDE_MODEL,
    };
  }
  return null;
}

export function createAssistRunner(deps: { cli: CliNamerDeps; getApiKey?: () => Promise<string | null>; run?: CommandRunner; fetchImpl?: typeof fetch }): AssistRunner {
  const run = deps.run ?? deps.cli.run ?? runCommand;
  const fetchImpl = deps.fetchImpl ?? fetch;

  async function viaClaude(req: AssistRequest): Promise<AssistResult | null> {
    const bin = await usable('claude', deps.cli);
    if (!bin) return null;
    const args = [
      '-p', '--model', ASSIST_CLAUDE_MODEL,
      ...(req.system ? ['--system-prompt', req.system] : []),
      '--tools', '', '--strict-mcp-config', '--setting-sources', '', '--disable-slash-commands',
      '--no-session-persistence', '--max-turns', '1', '--output-format', 'json',
    ];
    const started = Date.now();
    const r = await run(bin, args, { stdin: transcriptOf(req.messages), env: deps.cli.env(), cwd: scratchDir(), timeoutMs: CLAUDE_TIMEOUT_MS });
    if (r.code !== 0) return null;
    return parseClaudeJson(r.stdout, Date.now() - started);
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
        body: JSON.stringify({ model: ASSIST_OPENROUTER_MODEL, max_tokens: req.maxTokens, temperature: 0.2, messages: [...(req.system ? [{ role: 'system', content: req.system }] : []), ...req.messages] }),
      });
      if (!res.ok) return null;
      const data = (await res.json()) as { choices?: { message?: { content?: unknown } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number }; model?: string };
      const text = data.choices?.[0]?.message?.content;
      if (typeof text !== 'string') return null;
      return { text, usage: { inputTokens: data.usage?.prompt_tokens ?? 0, outputTokens: data.usage?.completion_tokens ?? 0 }, ms: Date.now() - started, model: data.model ?? ASSIST_OPENROUTER_MODEL };
    } catch { return null; }
    finally { clearTimeout(timer); }
  }

  return {
    available: async () => (await usable('claude', deps.cli)) !== null || !!(await deps.getApiKey?.().catch(() => null)),
    run: async (req) => (await viaClaude(req)) ?? (await viaOpenRouter(req)),
  };
}
