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
 * The structured "Pretty" transport (**`buildStructuredCommand`**) speaks ACP over
 * `grok agent stdio`; GrokStructuredSessionManager (structured/grok-manager.ts) translates
 * that into the Claude-shaped event stream the ChatView consumes, exactly as
 * CodexStructuredSessionManager does for the app-server protocol. Its MCP servers ride
 * `--plugin-dir` on the agent subcommand (the trusted plugin scope — see
 * buildStructuredCommand below), written per-thread by spawnStructured with no hooks: the
 * manager's own turn boundaries drive status, so hook-reported Stop events would
 * double-report.
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

  buildStructuredCommand({ secretsMcp, appendSystemPrompt, model, grokPluginDir }) {
    // Grok "Pretty" speaks ACP over `grok agent stdio`. Resume rides OUT-OF-BAND
    // (`session/load` over JSON-RPC, applied by GrokStructuredSessionManager via
    // StructuredSpawnOpts.resumeId), so `resumeSessionId` is deliberately not read here.
    //
    // Flag placement matters: `--rules` and `-m` are TOP-LEVEL flags (verified to parse
    // ahead of the subcommand), while `--always-approve` lives on the `agent` subcommand —
    // it is the stdio agent's own autonomy switch (the analogue of bypassPermissions; the
    // spike showed default stdio mode already runs tools unprompted, this makes it explicit).
    // The membrane still answers any session/request_permission a Grok mode ever emits.
    // MCP servers ride `--plugin-dir` — the agent subcommand's TRUSTED plugin scope. The
    // same plugin injected via GROK_HOME loads untrusted, and an untrusted plugin's MCP
    // tools are visible to the model but NOT callable (verified live: the thread could
    // name dispatch__report_status yet every use_tool call failed until --plugin-dir).
    const rules = [appendSystemPrompt, secretsMcp?.systemPrompt].filter(Boolean).join('\n\n');
    const args = [
      ...(rules ? ['--rules', rules] : []),
      ...modelArgs(model),
      'agent',
      ...(grokPluginDir ? ['--plugin-dir', grokPluginDir] : []),
      '--always-approve', 'stdio',
    ];
    return { command: 'grok', args };
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
