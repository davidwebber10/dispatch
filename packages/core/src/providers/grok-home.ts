import fs from 'fs';
import path from 'path';

/**
 * Builds the per-thread GROK_HOME a Grok thread runs under.
 *
 * Grok reads Claude Code plugin layouts, so one plugin directory carries both things
 * Dispatch injects per thread:
 *
 *   plugins/dispatch/.mcp.json          MCP servers (Doppler, the agency peer server)
 *   plugins/dispatch/hooks/hooks.json   lifecycle hooks, in Claude's own schema
 *
 * WHY a whole home rather than a flag: `--plugin-dir` exists only on the `grok agent`
 * SUBCOMMAND, not the top-level `grok` the PTY runs. Passing it there is a hard startup
 * error — "unexpected argument '--plugin-dir' found" — which is exactly how this was first
 * shipped. `GROK_HOME` is the documented way to point the top-level command at a different
 * config directory, and a plugin under `$GROK_HOME/plugins/` is discovered from there
 * (verified with `grok inspect`).
 *
 * Everything EXCEPT `plugins` is symlinked back to the real home, so the thread keeps the
 * user's credentials, their `config.toml`, and one shared session store — only the injected
 * plugin is per-thread. Without that isolation every thread would load every other thread's
 * hooks and report status for the wrong terminal.
 */

/** An MCP server entry, in the shape `.mcp.json` expects. */
export interface McpServerEntry {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  [key: string]: unknown;
}

export interface GrokHomeSpec {
  /** The per-thread home to build. Created if absent. */
  dir: string;
  /** The user's real `~/.grok`, whose entries (except `plugins`) are linked into `dir`. */
  realHome: string;
  /** MCP servers by name. Omit or leave empty to write no `.mcp.json` at all. */
  mcpServers?: Record<string, McpServerEntry>;
  /** Where lifecycle hooks POST. Omit to write no hooks. */
  eventsUrl?: string;
  /** Absolute path to scripts/grok-hook.mjs. Required alongside `eventsUrl`. */
  hookHelperPath?: string;
  /** Node binary the hook runs under. Defaults to the daemon's own. */
  nodePath?: string;
}

/**
 * The lifecycle events worth reporting, mirroring the Claude provider's set.
 *
 * `Stop` is the one that matters most — it is turn-complete, which is what moves a thread
 * out of "working". All of these exist in Grok: the binary carries the same event
 * vocabulary as Claude Code (Stop, PreToolUse, PostToolUse, SubagentStop, Idle,
 * SessionStart, SessionEnd, Notification, UserPromptSubmit, PreCompact).
 */
const ALWAYS_EVENTS = ['SessionStart', 'UserPromptSubmit', 'Notification', 'Stop', 'SessionEnd'] as const;
const TOOL_EVENTS = ['PreToolUse', 'PostToolUse'] as const;

/**
 * Link every entry of the real home into the per-thread one, except `plugins`.
 *
 * Sharing rather than copying matters: `auth.json` keeps the thread signed in, `config.toml`
 * keeps the user's own settings, and one `sessions` store means an assigned session id still
 * resolves on resume. Only `plugins` is genuinely per-thread.
 */
function linkRealHome(dir: string, realHome: string): void {
  let entries: string[];
  try { entries = fs.readdirSync(realHome); } catch { return; }
  for (const name of entries) {
    if (name === 'plugins') continue;
    const link = path.join(dir, name);
    const target = path.join(realHome, name);
    try {
      // Re-point a stale link (the real home can gain files between spawns) but never
      // clobber a real file we might have written.
      if (fs.lstatSync(link).isSymbolicLink()) {
        if (fs.readlinkSync(link) === target) continue;
        fs.unlinkSync(link);
      } else continue;
    } catch { /* not present yet — fall through and create it */ }
    try { fs.symlinkSync(target, link); } catch { /* best-effort: a missing link is not fatal */ }
  }
}

/** Quote a path for embedding in a hook's single `command` string. */
function quote(p: string): string {
  return `'${p.replace(/'/g, `'\\''`)}'`;
}

export function buildHooksJson(eventsUrl: string, hookHelperPath: string, nodePath: string): Record<string, unknown> {
  // A `command` hook receives the event JSON on stdin; grok-hook.mjs forwards it.
  const hook = { type: 'command', command: `${quote(nodePath)} ${quote(hookHelperPath)} ${quote(eventsUrl)}` };
  const always = [{ hooks: [hook] }];
  const everyTool = [{ matcher: '*', hooks: [hook] }];

  const hooks: Record<string, unknown> = {};
  for (const e of ALWAYS_EVENTS) hooks[e] = always;
  for (const e of TOOL_EVENTS) hooks[e] = everyTool;
  return { hooks };
}

/**
 * Write the plugin directory and return its path, or null when there is nothing to inject
 * — a thread with neither MCP servers nor a status URL should not be handed an empty
 * plugin dir to load.
 */
export function writeGrokHome(spec: GrokHomeSpec): string | null {
  const hasMcp = !!spec.mcpServers && Object.keys(spec.mcpServers).length > 0;
  const hasHooks = !!spec.eventsUrl && !!spec.hookHelperPath;
  if (!hasMcp && !hasHooks) return null;

  fs.mkdirSync(spec.dir, { recursive: true });
  linkRealHome(spec.dir, spec.realHome);

  const pluginDir = path.join(spec.dir, 'plugins', 'dispatch');
  fs.mkdirSync(pluginDir, { recursive: true });

  const mcpPath = path.join(pluginDir, '.mcp.json');
  if (hasMcp) fs.writeFileSync(mcpPath, JSON.stringify({ mcpServers: spec.mcpServers }, null, 2));
  // Stale files from a previous spawn would keep injecting servers this one dropped.
  else if (fs.existsSync(mcpPath)) fs.rmSync(mcpPath, { force: true });

  const hooksDir = path.join(pluginDir, 'hooks');
  const hooksPath = path.join(hooksDir, 'hooks.json');
  if (hasHooks) {
    fs.mkdirSync(hooksDir, { recursive: true });
    const json = buildHooksJson(spec.eventsUrl!, spec.hookHelperPath!, spec.nodePath ?? process.execPath);
    fs.writeFileSync(hooksPath, JSON.stringify(json, null, 2));
  } else if (fs.existsSync(hooksPath)) {
    fs.rmSync(hooksPath, { force: true });
  }

  return spec.dir;
}
