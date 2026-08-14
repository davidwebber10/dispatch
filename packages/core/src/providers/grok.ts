import type { SessionProvider, SecretsMcpInjection } from './types.js';

/**
 * Run Grok fully autonomously. This is Grok's analogue of Claude's
 * `--dangerously-skip-permissions` and Codex's `--dangerously-bypass-approvals-and-sandbox`:
 * a Dispatch thread is an autonomous agent, not an interactive session that should stop to
 * ask. Verified against `grok --help` on Grok 1.0.3 — the permission modes are
 * `default | acceptEdits | auto | dontAsk | bypassPermissions | plan`.
 *
 * Note there is NO `--yolo` flag, despite what several third-party guides claim. The
 * closest documented sibling is `--always-approve` (auto-approve each tool execution);
 * `bypassPermissions` skips the permission layer outright, which is the stronger and more
 * direct match for what the other two providers do.
 */
const FULL_PERMISSIONS = ['--permission-mode', 'bypassPermissions'];

/**
 * Pins the model for a Grok thread. `-m/--model <MODEL>` takes a model id
 * (e.g. `grok-4.5`); omitted → the CLI's configured default. `grok models` prints the
 * list an authenticated install can actually reach.
 */
function modelArgs(model?: string): string[] {
  return model ? ['--model', model] : [];
}

/**
 * The standing instructions that ride with the injected servers — "use Doppler for
 * secrets", the peer-tools prompt, the tools-awareness note.
 *
 * Registering an MCP server hands the agent the tools; this is how it learns to reach for
 * them. Claude uses `--append-system-prompt` and Codex a developer instruction; Grok
 * documents `--rules` as "extra rules to append to the system prompt".
 */
function rulesArgs(secretsMcp?: SecretsMcpInjection): string[] {
  return secretsMcp?.systemPrompt ? ['--rules', secretsMcp.systemPrompt] : [];
}

/**
 * xAI's Grok Build CLI (`grok`), installed by `curl -fsSL https://x.ai/cli/install.sh | bash`.
 *
 * Driven the same way as Claude Code and Codex, through the same four injections:
 *
 * - **MCP servers** (Doppler secrets, integrations, the agency peer server) and
 *   **status hooks** — both written into a plugin under a per-thread `GROK_HOME`, NOT argv.
 *   Grok carries Claude Code's whole hook vocabulary (`Stop`, `PreToolUse`, `PostToolUse`,
 *   `SubagentStop`, `Idle`, `SessionStart`, `SessionEnd`, `Notification`,
 *   `UserPromptSubmit`, `PreCompact`). See providers/grok-home.ts.
 * - **The system prompt** — `--rules`, Grok's `--append-system-prompt`.
 * - **The session id** — assigned up front with `--session-id` rather than discovered.
 *
 * ONE capability is genuinely absent: **`buildStructuredCommand`**. Grok has a bidirectional
 * stdio channel (`grok agent stdio`, speaking ACP), so a "Pretty" transport is possible in
 * principle, but it needs its own manager translating ACP into the Claude-shaped event
 * stream the ChatView consumes — exactly what CodexStructuredSessionManager does for the
 * app-server protocol. Until then Grok threads are CLI (PTY) only, and the New Thread modal
 * renders Pretty disabled for Grok.
 *
 * Two corrections worth keeping, both from reading the wrong help text:
 *   - An earlier version claimed Grok had no hooks and no MCP injection. Wrong: they are in
 *     the README the installer writes to `~/.grok/README.md`, not in `--help`.
 *   - They were then injected with `--plugin-dir`, which exists only on the `grok agent`
 *     SUBCOMMAND. On the top-level command it is a hard startup error. Hence GROK_HOME.
 */
export const grokProvider: SessionProvider = {
  name: 'grok',
  displayName: 'Grok',
  statusStrategy: 'hooks',
  // `-s/--session-id <UUID>` names a NEW conversation, so Dispatch can assign the id up
  // front instead of hunting for it afterwards. Grok requires a valid UUID that does not
  // already exist under the session directory — a fresh v4 satisfies both.
  assignsSessionId: true,

  buildStatusHooks({ serverUrl, terminalId, grokHelperPath }) {
    // Grok carries Claude Code's whole hook vocabulary — Stop, PreToolUse, PostToolUse,
    // SubagentStop, Idle, SessionStart, SessionEnd, Notification, UserPromptSubmit,
    // PreCompact — so the same lifecycle reporting works, delivered via GROK_HOME.
    if (!grokHelperPath) return undefined;
    return { grokHooks: { eventsUrl: `${serverUrl}/api/events/grok/${terminalId}`, helperPath: grokHelperPath } };
  },

  buildNewCommand({ prompt, model, sessionId, secretsMcp }) {
    // NOTE: hooks and MCP servers do NOT ride in argv. `--plugin-dir` exists only on the
    // `grok agent` subcommand; passing it to the top-level command is a startup error. They
    // are injected through a per-thread GROK_HOME instead — see providers/grok-home.ts.
    const args = [...FULL_PERMISSIONS, ...rulesArgs(secretsMcp), ...modelArgs(model)];
    if (sessionId) args.push('--session-id', sessionId);
    // The initial prompt is positional: `grok "fix the bug"`, so it goes last.
    if (prompt) args.push(prompt);
    return { command: 'grok', args };
  },

  buildResumeCommand({ externalSessionId, model, secretsMcp }) {
    // `-r/--resume <SESSION_ID_OR_TITLE>` resumes in place. A resumed thread must run as
    // autonomously as a fresh one, so it carries the same permission mode — and the same
    // hooks and MCP servers, or it would come back mute.
    return { command: 'grok', args: [...FULL_PERMISSIONS, ...rulesArgs(secretsMcp), ...modelArgs(model), '--resume', externalSessionId] };
  },

  buildRunnerCommand({ prompt, secretsMcp }) {
    // `-p/--single <PROMPT>` runs one turn, prints to stdout and EXITS — the process exit
    // is the run-completion signal, mirroring `codex exec`.
    //
    // Output stays `plain` on purpose. Grok's `streaming-json` emits ACP session updates,
    // which RunStreamParser cannot parse (it knows Claude's stream-json and Codex's event
    // JSON). A plain transcript is honest; live step parsing waits for a parser.
    return { command: 'grok', args: [...FULL_PERMISSIONS, ...rulesArgs(secretsMcp), '--single', prompt] };
  },
};
