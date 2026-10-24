import * as fs from 'fs';
import * as path from 'path';

export interface McpServerSpec {
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  envVars?: string[];
  /**
   * This server receives the thread key through the environment (per-thread keys, spec 6.3). The key
   * is never a literal in a file or in argv: Claude-style files and Grok and OpenCode configs carry a
   * reference to the variable, the Codex CLI passes the variable through with `env_vars`, and only a
   * Codex Pretty thread config holds the literal (it goes over a pipe to the app-server).
   */
  authEnv?: boolean;
}

/** The variable that carries the key into a server; the Codex CLI view carries a key-file path. */
export type AuthVar = 'DISPATCH_AUTH' | 'DISPATCH_AUTH_FILE';

export function composeInjection(
  specs: McpServerSpec[],
  opts: {
    configPath: string;
    prompts: string[];
    developerNote?: string | null;
    /** Which variable an authEnv server reads. Default DISPATCH_AUTH. */
    authVar?: AuthVar;
    /** Codex Pretty only: the literal key for the thread config of an authEnv server. */
    codexAuthLiteral?: string;
  },
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
    const authVar: AuthVar = opts.authVar ?? 'DISPATCH_AUTH';
    for (const s of specs) {
      // A reference, never the key itself, in the file that Claude reads.
      const fileEnv = s.authEnv ? { ...(s.env ?? {}), [authVar]: '${' + authVar + '}' } : s.env;
      mcpServers[s.name] = { command: s.command, args: s.args, ...(fileEnv ? { env: fileEnv } : {}) };
      codexArgs.push('-c', `mcp_servers.${s.name}.command=${JSON.stringify(s.command)}`);
      codexArgs.push('-c', `mcp_servers.${s.name}.args=${JSON.stringify(s.args)}`);
      if (s.authEnv) codexArgs.push('-c', `mcp_servers.${s.name}.env_vars=${JSON.stringify([...(s.envVars ?? []), authVar])}`);
      else if (s.envVars?.length) codexArgs.push('-c', `mcp_servers.${s.name}.env_vars=${JSON.stringify(s.envVars)}`);
      // Literal env (catalog integrations): Codex parses each -c value as TOML, and a JSON
      // object isn't valid TOML, so set each key via a dotted-path nested override (mirrors
      // Claude's `env`). Skip when envVars is set — that spec (e.g. Doppler) uses `${VAR}`
      // placeholders + Codex `env_vars` pass-through, so a literal `env` would mis-set them.
      if (s.env && (s.authEnv || !s.envVars?.length)) for (const [k, v] of Object.entries(s.env)) codexArgs.push('-c', `mcp_servers.${s.name}.env.${k}=${JSON.stringify(v)}`);
      if (s.authEnv) {
        // The thread config goes to the app-server over a pipe, so it may hold the literal (probe
        // results). Never env_vars: the shared app-server env holds no key to pass through.
        const env = { ...(s.env ?? {}), ...(opts.codexAuthLiteral ? { DISPATCH_AUTH: opts.codexAuthLiteral } : {}) };
        codexThreadConfig[`mcp_servers.${s.name}`] = {
          command: s.command,
          args: s.args,
          ...(Object.keys(env).length ? { env } : {}),
        };
      } else {
        codexThreadConfig[`mcp_servers.${s.name}`] = {
          command: s.command,
          args: s.args,
          ...(s.envVars?.length ? { env_vars: s.envVars } : s.env ? { env: s.env } : {}),
        };
      }
    }
    fs.mkdirSync(path.dirname(opts.configPath), { recursive: true });
    // Owner-only: the file can hold literal integration values. writeFileSync's mode applies only
    // when it creates the file, so tighten an older 0644 file too.
    fs.writeFileSync(opts.configPath, JSON.stringify({ mcpServers }, null, 2), { mode: 0o600 });
    try { fs.chmodSync(opts.configPath, 0o600); } catch { /* best effort on FS that lacks chmod */ }
    claudeConfigPath = opts.configPath;
  }

  const note = opts.developerNote?.trim() ? opts.developerNote.trim() : null;
  if (note) codexArgs.push('-c', `developer_instructions=${JSON.stringify(note)}`);

  const sysParts = [...opts.prompts.filter(Boolean), ...(note ? [note] : [])];
  return { claudeConfigPath, codexArgs, systemPrompt: sysParts.length ? sysParts.join('\n\n') : null, codexThreadConfig };
}
