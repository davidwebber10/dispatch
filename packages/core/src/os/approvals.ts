// packages/core/src/os/approvals.ts
// "Smart approvals": the third approval setting of a chat thread (2026-11-11).
//
//   auto   every tool runs (today's plain chat thread)
//   ask    every gated tool waits for the person (today's supervised membrane)
//   smart  the harness's own risk judgement lets routine work run, and asks or blocks the rest:
//          Claude Code  --permission-mode auto (its classifier) + `ask` rules; every can_use_tool
//                       that still arrives is surfaced; a classifier block becomes a card
//          Codex        approvalPolicy on-request + workspace-write + approvalsReviewer auto_review;
//                       a reviewer denial becomes a card, a high-risk request a pending approval
//          Grok/OpenCode a STATIC rule set (below): reads/searches and edits inside the project run,
//                       shell commands other than a short safe list ask, web requests ask, MCP
//                       tools ask except the os-tools read tools. Rule-based, not a risk judgement.
//
// `smart` is the default for a new thread under the BUSINESS profile; the developer default is
// unchanged. The setting lives in the thread's config as `approvals`.
import path from 'node:path';

export type Approvals = 'auto' | 'ask' | 'smart';
export const APPROVALS: readonly Approvals[] = ['auto', 'ask', 'smart'];

export function isApprovals(v: unknown): v is Approvals {
  return typeof v === 'string' && (APPROVALS as readonly string[]).includes(v);
}

/**
 * The approvals of one thread: its saved `approvals`, else `smart` for a plain chat thread of a
 * business person, else null (the thread keeps today's behaviour: autonomy/escalate decide).
 * Coordinators, agents and headless runs never default to smart: they have their own membranes.
 */
export function approvalsFor(config: Record<string, unknown>, profile: 'business' | 'developer'): Approvals | null {
  if (isApprovals(config.approvals)) return config.approvals;
  const plain = !config.role && !config.runner && !config.roleAuthority;
  return plain && profile === 'business' ? 'smart' : null;
}

/**
 * Claude Code `permissions.ask` rules in smart mode. Built-in tools: none (the classifier decides).
 * EXTEND HERE: company-system WRITE tools (e.g. `mcp__os-tools__gmail_send`) once OS marks them; an
 * `ask` rule forces a can_use_tool request even in auto mode (measured 2026-11-11), and MCP
 * annotations (readOnlyHint/destructiveHint) change nothing.
 */
export function claudeSmartAskRules(extra: readonly string[] = []): string[] {
  return [...extra];
}

/** The inline `--settings` JSON for smart mode, or null when there is no rule to add. */
export function claudeSmartSettings(rules: readonly string[]): string | null {
  return rules.length ? JSON.stringify({ permissions: { ask: rules } }) : null;
}

/** Shell commands smart mode lets run without asking (Grok/OpenCode). First word(s), no shell operators. */
export const SAFE_COMMANDS = ['ls', 'pwd', 'cat', 'head', 'tail', 'wc', 'echo', 'rg', 'grep', 'find', 'which', 'git status', 'git diff', 'git log', 'git show', 'git branch'];

/** True when a shell command is one plain safe command (no pipes, redirects, chaining or substitution). */
export function isSafeCommand(cmd: string): boolean {
  const c = cmd.trim();
  if (!c || /[|;&<>`$(){}\\\n]/.test(c)) return false;
  return SAFE_COMMANDS.some((s) => c === s || c.startsWith(s + ' '));
}

/** os-tools tools whose name says they only read (smart mode lets them run on Grok/OpenCode). */
export function isOsToolsRead(toolName: string): boolean {
  const n = toolName.toLowerCase();
  if (!/os-tools|os_tools/.test(n)) return false;
  return /(^|[_.-])(list|search|get|read|find|query|describe|lookup)([_.-]|$)/.test(n.replace(/^.*(os-tools|os_tools)[_.-]*/, ''));
}

/** OpenCode's `permission` block for smart mode. Its MCP tools are named `<server>_<tool>`. */
export function opencodeSmartPermission(): Record<string, unknown> {
  const bash: Record<string, string> = { '*': 'ask' };
  for (const s of SAFE_COMMANDS) { bash[s] = 'allow'; bash[`${s} *`] = 'allow'; }
  return {
    '*': 'ask',
    read: 'allow', list: 'allow', glob: 'allow', grep: 'allow', todowrite: 'allow', todoread: 'allow',
    edit: 'allow',
    // A path outside the project asks (OpenCode's own rule for files beyond the working dir).
    external_directory: 'ask',
    bash,
    webfetch: 'ask', websearch: 'ask',
    'os-tools_*': 'ask',
    'os-tools_*list*': 'allow', 'os-tools_*search*': 'allow', 'os-tools_*get*': 'allow', 'os-tools_*read*': 'allow',
  };
}

/** True when `p` is inside `root` (both resolved). */
function inside(root: string, p: string): boolean {
  const r = path.resolve(root);
  const q = path.resolve(root, p);
  return q === r || q.startsWith(r + path.sep);
}

/**
 * Grok (ACP) smart rule: allow (true) or ask the person (false). `kind` is ACP's tool kind
 * (read, edit, search, execute, fetch, …); `input` the tool's raw input.
 */
export function acpSmartAllows(kind: string | undefined, toolName: string, input: any, workDir: string): boolean {
  const k = (kind ?? '').toLowerCase();
  const paths = [input?.path, input?.file_path, input?.filePath, input?.abs_path, ...(Array.isArray(input?.paths) ? input.paths : [])].filter((x): x is string => typeof x === 'string');
  if (k === 'read' || k === 'search' || k === 'think') return paths.every((p) => inside(workDir, p));
  if (k === 'edit' || k === 'delete' || k === 'move') return paths.length > 0 && paths.every((p) => inside(workDir, p));
  if (k === 'execute') {
    const cmd = typeof input?.command === 'string' ? input.command : Array.isArray(input?.command) ? input.command.join(' ') : '';
    return isSafeCommand(cmd);
  }
  if (k === 'fetch') return false;
  return isOsToolsRead(toolName);
}

/** A plain title for a card: what the thread wants to do. */
export function approvalTitle(toolName: string, input?: any): string {
  const n = toolName.toLowerCase();
  if (n === 'bash' || n.includes('command') || n === 'execute' || n === 'shell') return 'Wants to run a command';
  if (/send.*(mail|email|message)|gmail_send|email/.test(n)) return 'Wants to send an email';
  if (n === 'write' || n === 'edit' || n === 'multiedit' || n.includes('patch') || n.includes('edit')) return 'Wants to change a file';
  if (n === 'webfetch' || n === 'websearch' || n.includes('network') || n.includes('fetch')) return 'Wants to reach the internet';
  if (n.startsWith('mcp__') || n.includes('os-tools')) return `Wants to use ${toolName.replace(/^mcp__/, '').replace(/__/g, ' › ')}`;
  void input;
  return `Wants to use ${toolName}`;
}

/** The user message that names and approves a blocked action (Claude: a retry then goes through, measured). */
export function approvalMessage(b: { toolName: string; detail?: string | null }): string {
  const what = b.detail ? `${b.toolName}: ${b.detail}` : b.toolName;
  return `I approve the action that was just blocked (${what}). Please go ahead and run it now.`;
}

/** A short detail of a tool input for a card or a message: the command, the path or the URL. */
export function inputDetail(input: any): string | null {
  if (!input || typeof input !== 'object') return typeof input === 'string' ? input.slice(0, 300) : null;
  const v = input.command ?? input.cmd ?? input.file_path ?? input.path ?? input.url ?? input.query;
  if (typeof v === 'string') return v.slice(0, 300);
  if (Array.isArray(v)) return v.join(' ').slice(0, 300);
  return null;
}

/** An action the harness blocked by itself (Claude's classifier, Codex's reviewer): the card's data. */
export interface BlockedAction {
  id: string;
  toolName: string;
  title: string;
  detail: string | null;
  /** The classifier's or reviewer's reason, as the harness gave it. */
  reason: string | null;
  riskLevel?: string | null;
  at: number;
}

/** The thread event a blocked action becomes (kept in the replay ring and the journal). */
export function blockedEvent(b: BlockedAction): Record<string, unknown> {
  return { type: 'system', subtype: 'permission_blocked', block: b };
}
export function blockedResolvedEvent(id: string, decision: 'allow' | 'keep'): Record<string, unknown> {
  return { type: 'system', subtype: 'permission_blocked_resolved', id, decision };
}

/** The one line a thread gets when smart approvals are not available and it falls back to asking. */
export const SMART_FALLBACK_NOTICE = 'Smart approvals are not available for this model. Dispatch asks you before each tool runs instead.';
