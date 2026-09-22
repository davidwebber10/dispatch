// Normalizes a manager's surfaced tool-approval into the vocabulary `coordinatorToolPolicy`
// (coordinator-policy.ts) matches — Claude tool names ('Bash' + `{ command }`, 'Write'/'Edit'/…
// + `{ file_path }`) — so the same policy can gate a coordinator regardless of which harness
// (Claude Code, Codex, …) surfaced the approval. Pure — no I/O, no state.

export type PendingApproval = { toolName: string; input: unknown };

type CodexShellInput = { command?: unknown };
type CodexChange = { path?: unknown };
type CodexApplyPatchInput = { file_path?: unknown; changes?: unknown };

function adaptCodex(pending: PendingApproval): PendingApproval {
  const inp = (pending.input && typeof pending.input === 'object' ? pending.input : {}) as Record<string, unknown>;

  if (pending.toolName === 'Shell') {
    const { command } = inp as CodexShellInput;
    return { toolName: 'Bash', input: { command } };
  }

  if (pending.toolName === 'ApplyPatch') {
    const { file_path, changes } = inp as CodexApplyPatchInput;
    const changeList = Array.isArray(changes) ? (changes as CodexChange[]) : [];
    const paths = changeList.map((c) => ({ path: c?.path }));
    const firstPath = paths[0]?.path;
    return {
      toolName: 'Write',
      // `file_path` keeps back-compat with single-file callers; `changes` carries every path
      // in the patch so a multi-file ApplyPatch can be fully checked downstream (see Task 4).
      input: { file_path: file_path ?? firstPath, changes: paths },
    };
  }

  // Any other codex tool name is not yet mapped — pass through unchanged.
  return pending;
}

/**
 * Adapts a harness's surfaced tool-approval (toolName + input) into the shape
 * `coordinatorToolPolicy` understands, so one policy can gate every harness's coordinator.
 *
 *  - 'claude-code': already the right shape — identity.
 *  - 'codex': 'Shell' → Bash/{command}; 'ApplyPatch' → Write/{file_path, changes}.
 *  - 'grok' / 'opencode' (ACP-based harnesses) and any unrecognized harness: STUB.
 *    // TODO(phase-3): ACP surfaces approvals as { kind, title, rawInput, locations[] } —
 *    // mapping that into Bash/{command} or Write/{file_path} needs its own translation
 *    // (locations[].path for file targets, rawInput for the command/diff). Until that
 *    // lands, ACP approvals pass through unchanged and are NOT gated by coordinatorToolPolicy.
 */
export function adaptForPolicy(harness: string, pending: PendingApproval): PendingApproval {
  if (harness === 'codex') return adaptCodex(pending);
  // 'claude-code', 'grok', 'opencode', and any unknown harness are identity today.
  return pending;
}
