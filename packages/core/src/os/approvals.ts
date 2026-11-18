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
//                       tools ask except the read tools of the company systems (os/os-servers.ts).
//                       Rule-based, not a risk judgement.
//
// `smart` is the default for a new thread under the BUSINESS profile; the developer default is
// unchanged. The setting lives in the thread's config as `approvals`.
import path from 'node:path';
import { currentOsServerNames } from './os-servers.js';

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
 * EXTEND HERE: company-system WRITE tools (e.g. `mcp__gmail__send`) once OS marks them; an
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

const READ_VERB = /(^|[_.-])(list|search|get|read|find|query|describe|lookup)([_.-]|$)/;
const escapeRe = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * A company-system tool whose name says it only reads (smart mode lets it run on Grok/OpenCode).
 * `servers`: the company-system server names (os/os-servers.ts); a tool of any other server is not
 * a company tool. The harness may name it `mcp__<server>__<tool>`, `<server>__<tool>` or `<server>_<tool>`.
 */
export function isOsToolsRead(toolName: string, servers: readonly string[] = currentOsServerNames()): boolean {
  const n = toolName.toLowerCase();
  for (const s of [...servers].sort((a, b) => b.length - a.length)) {
    const m = new RegExp(`^(mcp__)?${escapeRe(s.toLowerCase())}(__|_|\\.)(.+)$`).exec(n);
    if (m) return m[3] === 'list' || READ_VERB.test(m[3]);
  }
  return false;
}

/** OpenCode's `permission` block for smart mode. Its MCP tools are named `<server>_<tool>`. */
export function opencodeSmartPermission(osServers: readonly string[] = currentOsServerNames()): Record<string, unknown> {
  const bash: Record<string, string> = { '*': 'ask' };
  for (const s of SAFE_COMMANDS) { bash[s] = 'allow'; bash[`${s} *`] = 'allow'; }
  const company: Record<string, string> = {};
  for (const s of osServers) {
    company[`${s}_*`] = 'ask';
    for (const verb of ['list', 'search', 'get', 'read']) company[`${s}_*${verb}*`] = 'allow';
  }
  return {
    '*': 'ask',
    read: 'allow', list: 'allow', glob: 'allow', grep: 'allow', todowrite: 'allow', todoread: 'allow',
    edit: 'allow',
    // A path outside the project asks (OpenCode's own rule for files beyond the working dir).
    external_directory: 'ask',
    bash,
    webfetch: 'ask', websearch: 'ask',
    ...company,
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
  if (/send.*(mail|email|message)|(mail|message)[a-z_-]*__send|gmail_send|email/.test(n)) return 'Wants to send an email';
  if (n === 'write' || n === 'edit' || n === 'multiedit' || n.includes('patch') || n.includes('edit')) return 'Wants to change a file';
  if (n === 'webfetch' || n === 'websearch' || n.includes('network') || n.includes('fetch')) return 'Wants to reach the internet';
  if (n.startsWith('mcp__')) return `Wants to use ${toolName.replace(/^mcp__/, '').replace(/__/g, ' › ')}`;
  void input;
  return `Wants to use ${toolName}`;
}

// ── "Allow this": the person allows ONE blocked call ──────────────────────────────────────────────
// The allowance is a fact the DAEMON holds, set only by the owner's authenticated request
// (POST /api/terminals/:id/blocked/:blockId). It is never a sentence: no text in the conversation
// (the model's, a tool result's, a web page's) can allow a blocked call through the daemon.
// How each harness takes it:
//   Claude Code   the daemon puts the CLI in its asking mode (a control request), tells the model to
//                 run the call again, and answers `allow` to the request for exactly that call
//                 (structured/manager.ts allowOnce). Anything else asked in that window waits for the person.
//   Codex         its own override request for a reviewer denial. If Codex refuses it, nothing is
//                 allowed: the person asks again and is asked first.
// The limit, said plainly: while a thread runs in the harness's own smart mode, the harness's risk
// judgement reads the conversation, and Dispatch does not control what that judgement makes of text
// in it. Dispatch adds no approval sentence to the conversation and lets no key write one.

/** How long the daemon holds one allowed call before it goes back to the smart mode. */
export const ALLOW_ONCE_MS = 120_000;

/** The line that asks the model to run the allowed call again. It allows nothing by itself. */
export function allowedOnceMessage(b: { toolName: string; detail?: string | null }): string {
  const what = b.detail ? `${b.toolName}: ${b.detail}` : b.toolName;
  return `[Dispatch] The action that was blocked (${what}) may run once. Run it again now, exactly as it was. Any other action will be checked as usual.`;
}

/** Keys in order, so two inputs with the same content compare equal. */
function stable(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'undefined';
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stable(o[k])}`).join(',')}}`;
}

/** True when two tool calls are the same call: the same tool and the same input, value for value. */
export function sameToolCall(a: { toolName: string; input: unknown }, b: { toolName: string; input: unknown }): boolean {
  return a.toolName === b.toolName && a.input !== undefined && stable(a.input) === stable(b.input);
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
  /** subagents-v1: the subagent whose action was blocked (absent: the main agent). */
  agentId?: string;
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
