/**
 * Normalizes provider-specific lifecycle events (Claude Code hooks, Codex notify)
 * into one thread status model + a human activity label + the provider session id.
 * Pure and provider-agnostic so it's easy to test and extend.
 */

export type ThreadStatus = 'starting' | 'working' | 'needs_input' | 'idle' | 'done' | 'error';

export interface NormalizedEvent {
  /** null = this event doesn't change the status (still useful for sessionId capture). */
  status: ThreadStatus | null;
  activity?: string;
  sessionId?: string;
}

/** Claude Code hook payload (subset) -> normalized event. */
export function normalizeClaude(payload: any): NormalizedEvent {
  const event = str(payload?.hook_event_name) ?? '';
  const sessionId = str(payload?.session_id);
  const tool = str(payload?.tool_name);

  switch (event) {
    case 'SessionStart': return { status: 'starting', sessionId };
    case 'UserPromptSubmit': return { status: 'working', activity: 'Thinking…', sessionId };
    case 'PreToolUse': return { status: 'working', activity: toolActivity(tool, payload?.tool_input), sessionId };
    case 'PostToolUse': return { status: 'working', sessionId };
    case 'PostToolUseFailure': return { status: 'working', activity: tool ? `${tool} failed` : undefined, sessionId };
    case 'SubagentStart': return { status: 'working', activity: payload?.agent_type ? `Subagent: ${payload.agent_type}` : 'Subagent', sessionId };
    case 'PermissionRequest': return { status: 'needs_input', activity: tool ? `Approve ${tool}?` : 'Waiting for approval', sessionId };
    case 'Notification': {
      // Claude versions vary: some send a structured notification_type, others
      // only a human `message`. Check both so we still classify the prompt.
      const hint = (str(payload?.notification_type) ?? str(payload?.message) ?? '').toLowerCase();
      if (hint.includes('permission') || hint.includes('approve')) return { status: 'needs_input', activity: 'Waiting for approval', sessionId };
      if (hint.includes('idle') || hint.includes('waiting for')) return { status: 'idle', sessionId };
      return { status: null, sessionId };
    }
    case 'Stop': return { status: 'idle', sessionId };
    case 'StopFailure': return { status: 'error', activity: payload?.error_type ? `Error: ${payload.error_type}` : 'Error', sessionId };
    case 'SessionEnd': return { status: 'done', sessionId };
    default: return { status: null, sessionId };
  }
}

/** Codex notify payload (kebab-case keys) -> normalized event. */
export function normalizeCodex(payload: any): NormalizedEvent {
  const type = str(payload?.type) ?? '';
  const sessionId = str(payload?.['thread-id']) ?? str(payload?.thread_id);
  // `agent-turn-complete` = the turn finished -> idle. `approval-requested`
  // (interactive sessions) = the agent is blocked on the user -> needs_input.
  if (type === 'agent-turn-complete') return { status: 'idle', sessionId };
  if (type === 'approval-requested') return { status: 'needs_input', activity: 'Waiting for approval', sessionId };
  return { status: null, sessionId };
}

function toolActivity(tool: string | undefined, input: any): string | undefined {
  if (!tool) return undefined;
  if (tool === 'Bash' && input?.command) return `Running: ${truncate(String(input.command), 60)}`;
  const file = input?.file_path ?? input?.path ?? input?.notebook_path;
  if (file) return `${tool} ${basename(String(file))}`;
  if (tool === 'TodoWrite') return 'Updating plan';
  return tool;
}

function basename(p: string): string {
  const parts = p.split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : p;
}
function truncate(s: string, n: number): string { return s.length <= n ? s : s.slice(0, n - 1) + '…'; }
function str(v: unknown): string | undefined { return typeof v === 'string' && v ? v : undefined; }
