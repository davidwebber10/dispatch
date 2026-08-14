import fs from 'fs';
import path from 'path';

/**
 * Builds the per-spawn plugin directory Grok is handed with `--plugin-dir`.
 *
 * Grok reads Claude Code plugin layouts, so ONE directory carries both things Dispatch
 * needs to inject per thread:
 *
 *   .mcp.json          MCP servers (Doppler secrets, the agency peer server)
 *   hooks/hooks.json   lifecycle hooks, in Claude's own schema
 *
 * `--plugin-dir` is the session scope Grok documents as "highest-priority… always trusted —
 * hooks and MCP servers activate without a prompt", which is exactly what a spawned agent
 * needs: no trust prompt to stall on, and nothing written into the user's own config.
 */

/** An MCP server entry, in the shape `.mcp.json` expects. */
export interface McpServerEntry {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  [key: string]: unknown;
}

export interface GrokPluginSpec {
  /** Directory to write. Created if absent; its two generated files are overwritten. */
  dir: string;
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
export function writeGrokPlugin(spec: GrokPluginSpec): string | null {
  const hasMcp = !!spec.mcpServers && Object.keys(spec.mcpServers).length > 0;
  const hasHooks = !!spec.eventsUrl && !!spec.hookHelperPath;
  if (!hasMcp && !hasHooks) return null;

  fs.mkdirSync(spec.dir, { recursive: true });

  const mcpPath = path.join(spec.dir, '.mcp.json');
  if (hasMcp) fs.writeFileSync(mcpPath, JSON.stringify({ mcpServers: spec.mcpServers }, null, 2));
  // Stale files from a previous spawn would keep injecting servers this one dropped.
  else if (fs.existsSync(mcpPath)) fs.rmSync(mcpPath, { force: true });

  const hooksDir = path.join(spec.dir, 'hooks');
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
