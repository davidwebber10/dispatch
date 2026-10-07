import fs from 'fs';
import path from 'path';
import type { McpServerEntry } from './grok-home.js';
import { OPENCODE_DEFAULT_MODEL } from './opencode.js';

/**
 * Writes the per-thread OpenCode config an `opencode acp` child runs under, pointed at via
 * the OPENCODE_CONFIG env var (verified live: its `model` beats the user's global default).
 * This is OpenCode's analogue of writeGrokHome — everything Dispatch injects per thread in
 * one file:
 *
 *   model         the picked OpenRouter model (OPENCODE_DEFAULT_MODEL when none picked)
 *   permission    'allow' everywhere for an autonomous thread; 'ask' when supervised, which
 *                 makes OpenCode raise ACP session/request_permission — the SAME membrane
 *                 the Grok manager answers (grok-manager.ts handleApproval)
 *   instructions  the system prompt (peer tools, Doppler note), written to rules.md beside
 *                 the config — OpenCode takes instruction FILES, not inline text
 *   mcp           the injected MCP servers (Doppler secrets, the agency peer server), in
 *                 OpenCode's own {type:'local', command:[...]} shape
 *
 * No home dir dance is needed (unlike GROK_HOME): OPENCODE_CONFIG replaces only the config,
 * while auth (~/.local/share/opencode/auth.json) and session storage stay global — which is
 * exactly what a resume needs.
 */
export interface OpencodeConfigSpec {
  /** The per-thread directory the config (and rules.md) is written into. Created if absent. */
  dir: string;
  model?: string;
  /** True when the thread is supervised — tools surface as permission requests. */
  escalate?: boolean;
  systemPrompt?: string;
  mcpServers?: Record<string, McpServerEntry>;
  /**
   * True when the model has no tool-capable endpoint (settings/model-capabilities.ts). The
   * config then DENIES every tool (`permission: {"*": "deny"}` — built-ins and MCP alike)
   * and skips the MCP block, so the request reaches the provider with no tool list and the
   * thread runs chat-only. Verified live over `opencode acp` against OpenRouter 2026-10-06
   * with cognitivecomputations/dolphin-mistral-24b-venice-edition: with any tool left on it
   * fails with "No endpoints found that support tool use"; with this block it answers.
   * NOT the deprecated `tools: {"*": false}`: the permission block wins over it, so the
   * usual `bash: 'allow'` beside it re-enabled bash and the request still failed.
   */
  toolsDisabled?: boolean;
}

export function writeOpencodeConfig(spec: OpencodeConfigSpec): string {
  fs.mkdirSync(spec.dir, { recursive: true });

  const mode = spec.escalate ? 'ask' : 'allow';
  const cfg: Record<string, unknown> = {
    $schema: 'https://opencode.ai/config.json',
    model: spec.model || OPENCODE_DEFAULT_MODEL,
    permission: spec.toolsDisabled ? { '*': 'deny' } : { edit: mode, bash: mode, webfetch: mode },
  };

  const rulesPath = path.join(spec.dir, 'rules.md');
  if (spec.systemPrompt) {
    fs.writeFileSync(rulesPath, spec.systemPrompt);
    cfg.instructions = [rulesPath];
  } else if (fs.existsSync(rulesPath)) {
    // Stale rules from a previous spawn must not keep instructing this one.
    fs.rmSync(rulesPath, { force: true });
  }

  if (!spec.toolsDisabled && spec.mcpServers && Object.keys(spec.mcpServers).length > 0) {
    const mcp: Record<string, unknown> = {};
    for (const [name, s] of Object.entries(spec.mcpServers)) {
      mcp[name] = {
        type: 'local',
        command: [s.command, ...(s.args ?? [])].filter((p): p is string => typeof p === 'string' && p.length > 0),
        enabled: true,
        ...(s.env ? { environment: s.env } : {}),
      };
    }
    cfg.mcp = mcp;
  }

  const cfgPath = path.join(spec.dir, 'opencode.json');
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  return cfgPath;
}
