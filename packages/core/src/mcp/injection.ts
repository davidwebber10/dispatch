import * as fs from 'fs';
import * as path from 'path';

export interface McpServerSpec { name: string; command: string; args: string[]; env?: Record<string, string>; envVars?: string[]; }

export function composeInjection(specs: McpServerSpec[], opts: { configPath: string; prompts: string[] }): { claudeConfigPath: string | null; codexArgs: string[]; systemPrompt: string | null } {
  if (specs.length === 0) return { claudeConfigPath: null, codexArgs: [], systemPrompt: null };

  const mcpServers: Record<string, unknown> = {};
  const codexArgs: string[] = [];
  for (const s of specs) {
    mcpServers[s.name] = { command: s.command, args: s.args, ...(s.env ? { env: s.env } : {}) };
    codexArgs.push('-c', `mcp_servers.${s.name}.command=${JSON.stringify(s.command)}`);
    codexArgs.push('-c', `mcp_servers.${s.name}.args=${JSON.stringify(s.args)}`);
    if (s.envVars?.length) codexArgs.push('-c', `mcp_servers.${s.name}.env_vars=${JSON.stringify(s.envVars)}`);
    // Literal env (catalog integrations): Codex parses each -c value as TOML, and a JSON
    // object isn't valid TOML, so set each key via a dotted-path nested override (mirrors
    // Claude's `env`). Skip when envVars is set — that spec (e.g. Doppler) uses `${VAR}`
    // placeholders + Codex `env_vars` pass-through, so a literal `env` would mis-set them.
    if (s.env && !s.envVars?.length) for (const [k, v] of Object.entries(s.env)) codexArgs.push('-c', `mcp_servers.${s.name}.env.${k}=${JSON.stringify(v)}`);
  }
  fs.mkdirSync(path.dirname(opts.configPath), { recursive: true });
  fs.writeFileSync(opts.configPath, JSON.stringify({ mcpServers }, null, 2));
  const prompts = opts.prompts.filter(Boolean);
  return { claudeConfigPath: opts.configPath, codexArgs, systemPrompt: prompts.length ? prompts.join('\n\n') : null };
}
