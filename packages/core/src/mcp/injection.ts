import * as fs from 'fs';
import * as path from 'path';

export interface McpServerSpec { name: string; command: string; args: string[]; env?: Record<string, string>; envVars?: string[]; }

export function composeInjection(
  specs: McpServerSpec[],
  opts: { configPath: string; prompts: string[]; developerNote?: string | null },
): { claudeConfigPath: string | null; codexArgs: string[]; systemPrompt: string | null; codexThreadConfig: Record<string, unknown> } {
  const codexArgs: string[] = [];
  // Per-thread `config` for a Codex STRUCTURED thread (thread/start + thread/resume). The shared
  // app-server's argv belongs to whichever thread spawned it first, so per-thread MCP identity
  // (DISPATCH_TERMINAL / DISPATCH_SESSION / DISPATCH_SPAWN_DEPTH) must ride here instead (M3).
  // Dotted keys set one server each and MERGE with the user's config.toml mcp_servers; a thread
  // config also wins over an app-server `-c` — both live-verified on codex-cli 0.156.1.
  const codexThreadConfig: Record<string, unknown> = {};
  let claudeConfigPath: string | null = null;

  if (specs.length > 0) {
    const mcpServers: Record<string, unknown> = {};
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
      codexThreadConfig[`mcp_servers.${s.name}`] = {
        command: s.command,
        args: s.args,
        ...(s.envVars?.length ? { env_vars: s.envVars } : s.env ? { env: s.env } : {}),
      };
    }
    fs.mkdirSync(path.dirname(opts.configPath), { recursive: true });
    fs.writeFileSync(opts.configPath, JSON.stringify({ mcpServers }, null, 2));
    claudeConfigPath = opts.configPath;
  }

  const note = opts.developerNote?.trim() ? opts.developerNote.trim() : null;
  if (note) codexArgs.push('-c', `developer_instructions=${JSON.stringify(note)}`);

  const sysParts = [...opts.prompts.filter(Boolean), ...(note ? [note] : [])];
  return { claudeConfigPath, codexArgs, systemPrompt: sysParts.length ? sysParts.join('\n\n') : null, codexThreadConfig };
}
