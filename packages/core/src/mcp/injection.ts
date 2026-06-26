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
  }
  fs.mkdirSync(path.dirname(opts.configPath), { recursive: true });
  fs.writeFileSync(opts.configPath, JSON.stringify({ mcpServers }, null, 2));
  const prompts = opts.prompts.filter(Boolean);
  return { claudeConfigPath: opts.configPath, codexArgs, systemPrompt: prompts.length ? prompts.join('\n\n') : null };
}
