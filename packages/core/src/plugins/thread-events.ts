import type { EventBroadcaster } from '../ws/events.js';
import type { HarnessEvent } from '../runtime/events.js';
import { classifyUserText } from '../conversation/task-notification.js';

/**
 * Thread events for plugins (docs/superpowers/specs/2026-11-07-plugins-design.md, section 3.3):
 * one stream, whichever harness, of what a thread was launched with, what the user sent, which
 * tools the model called, how each turn ended, and what the thread declared. Sources: the
 * harness event layer (Pretty threads), the hook payloads Dispatch already receives (CLI
 * threads), native frames (tool_use blocks), the session service (prompts) and report_status.
 *
 * Every event goes to the owner's browser in full. `redactThreadEvent` is for a plugin
 * without `read:prompts`: lengths stay, text and tool input go.
 */
interface Base { terminalId: string; sessionId: string; harness: string; at: string }
export type ThreadEvent =
  | (Base & { type: 'thread:spawned'; toolsAvailable: string[] })
  | (Base & { type: 'thread:prompt'; source: PromptSource; text?: string; textLength: number })
  | (Base & { type: 'thread:tool'; tool: string; input?: unknown; inputLength: number })
  | (Base & { type: 'thread:turn'; ms: number | null; inputTokens: number | null; outputTokens: number | null; costUsd: number | null; outcome: string; declared?: boolean; summary?: string; partial?: boolean })
  | (Base & { type: 'thread:status'; state: 'done' | 'needs_you' | 'blocked'; summary: string; ask?: string; blocker?: string });

/** `automated`: a schedule or a role started the thread (`config.runner`, `config.roleRun`): its prompts are not the owner's. */
export type ThreadInfo = { sessionId: string; harness: string; automated?: boolean } | null;
/** True for a thread a schedule or a role started, from its config. */
export const isAutomatedThread = (config: Record<string, unknown> | null | undefined): boolean => !!(config && (config.runner || config.roleRun));
type Subscriber = (e: ThreadEvent) => void;
/** An event body without the identity the emitter adds (distributes over the union). */
/** Who sent a prompt: the owner, the Control Plane, a peer thread, the daemon itself (an auto-resume), or a schedule or role (a thread it started). */
export type PromptSource = 'user' | 'coordinator' | 'thread' | 'daemon' | 'schedule';

type Body = ThreadEvent extends infer E ? (E extends Base ? Omit<E, keyof Base> : never) : never;

/** Claude Code's prompt after a compaction: the summary of the earlier conversation, not a prompt. */
const COMPACTION_RE = /^\s*This session is being continued from a previous conversation/;
/** The line the daemon types into a CLI thread to attach a file (sessions/service.ts sendFileReference). */
const FILE_CONTEXT_LINE_RE = /^Use this file as context: .*$/gm;

/**
 * The owner's words in a hook prompt, or null when the prompt is injected text: a task
 * notification, a slash-command echo, the compaction summary, or only file-attach lines.
 * File-attach lines are cut from a mixed prompt.
 */
export function ownerText(text: string): string | null {
  if (classifyUserText(text).kind !== 'user') return null;
  if (COMPACTION_RE.test(text)) return null;
  if (!FILE_CONTEXT_LINE_RE.test(text)) return text;
  FILE_CONTEXT_LINE_RE.lastIndex = 0;
  const rest = text.replace(FILE_CONTEXT_LINE_RE, '').trim();
  return rest ? rest : null;
}

const REPORTED_TTL_MS = 10 * 60 * 1000;
const normalise = (text: string): string => text.replace(/\s+/g, ' ').trim();

interface OpenTurn { startedAt: number; input: number; output: number; cost: number | null; sawUsage: boolean }

export class ThreadEvents {
  private subscribers = new Set<Subscriber>();
  private turns = new Map<string, OpenTurn>();
  /**
   * Prompts the session service reported, per thread, that a hook may report again: a CLI
   * thread's hook fires for every prompt the owner typed or a peer sent, so the hook path keeps
   * only prompts nobody reported first. Matched on the words (whitespace collapsed: the PTY
   * parser and the hook disagree on line ends), consumed once, and dropped after ten minutes.
   */
  private reported = new Map<string, { norm: string; at: number }[]>();

  constructor(private readonly broadcaster: EventBroadcaster, private readonly lookup: (terminalId: string) => ThreadInfo, private readonly now: () => number = Date.now) {}

  subscribe(fn: Subscriber): () => void { this.subscribers.add(fn); return () => { this.subscribers.delete(fn); }; }

  private emit(terminalId: string, body: Body): void {
    const info = this.lookup(terminalId);
    if (!info) return;
    const e = { terminalId, sessionId: info.sessionId, harness: info.harness, at: new Date(this.now()).toISOString(), ...body } as ThreadEvent;
    this.broadcaster.broadcast(e as unknown as Record<string, unknown>);
    for (const fn of this.subscribers) { try { fn(e); } catch (err) { console.warn('[plugins] a thread-event subscriber failed:', err instanceof Error ? err.message : err); } }
  }

  /** The session service saw a prompt go to a thread (the owner typed it, a peer or the Control Plane sent it). */
  onPrompt(terminalId: string, text: string, source: PromptSource): void {
    this.remember(terminalId, text);
    this.promptSeen(terminalId, text, source);
  }

  /** A hook's UserPromptSubmit: a prompt the service already reported is consumed; any other is the owner's. */
  private onHookPrompt(terminalId: string, text: string): void {
    if (this.consume(terminalId, text)) return;
    // Text the harness or the daemon injected is nobody's prompt (coach fix T1).
    const own = ownerText(text);
    if (own === null) return;
    this.promptSeen(terminalId, own, 'user');
  }

  private promptSeen(terminalId: string, text: string, source: PromptSource): void {
    if (!this.turns.has(terminalId)) this.turns.set(terminalId, { startedAt: this.now(), input: 0, output: 0, cost: null, sawUsage: false });
    // In a thread a schedule or a role started, "the owner's" prompt is the schedule's (a runner's launch prompt reaches the hook).
    const from: PromptSource = source === 'user' && this.lookup(terminalId)?.automated ? 'schedule' : source;
    this.emit(terminalId, { type: 'thread:prompt', source: from, text, textLength: text.length });
  }

  private remember(terminalId: string, text: string): void {
    const list = this.recent(terminalId);
    list.push({ norm: normalise(text), at: this.now() });
    if (list.length > 20) list.splice(0, list.length - 20);
    this.reported.set(terminalId, list);
  }

  private consume(terminalId: string, text: string): boolean {
    const list = this.recent(terminalId);
    const norm = normalise(text);
    const i = list.findIndex((r) => r.norm === norm);
    if (i < 0) return false;
    list.splice(i, 1);
    this.reported.set(terminalId, list);
    return true;
  }

  private recent(terminalId: string): { norm: string; at: number }[] {
    const t = this.now();
    return (this.reported.get(terminalId) ?? []).filter((r) => t - r.at < REPORTED_TTL_MS);
  }

  onTool(terminalId: string, tool: string, input: unknown): void {
    let inputLength = 0;
    try { inputLength = JSON.stringify(input ?? null).length; } catch { inputLength = 0; }
    this.emit(terminalId, { type: 'thread:tool', tool, input, inputLength });
  }

  onStatus(terminalId: string, decl: { state: 'done' | 'needs_you' | 'blocked'; summary: string; ask?: string; blocker?: string }): void {
    this.emit(terminalId, { type: 'thread:status', state: decl.state, summary: decl.summary, ...(decl.ask ? { ask: decl.ask } : {}), ...(decl.blocker ? { blocker: decl.blocker } : {}) });
  }

  onSpawned(terminalId: string, toolsAvailable: string[]): void {
    this.emit(terminalId, { type: 'thread:spawned', toolsAvailable });
  }

  /** A hook payload Dispatch received for a CLI thread (Claude Code's HTTP hooks, Grok's helper). */
  onHookPayload(_provider: string, terminalId: string, payload: unknown): void {
    const p = (payload ?? {}) as Record<string, unknown>;
    const event = typeof p.hook_event_name === 'string' ? p.hook_event_name : '';
    if (event === 'UserPromptSubmit' && typeof p.prompt === 'string') this.onHookPrompt(terminalId, p.prompt);
    else if (event === 'PreToolUse' && typeof p.tool_name === 'string') this.onTool(terminalId, p.tool_name, p.tool_input);
    else if (event === 'Stop' || event === 'StopFailure') this.closeTurn(terminalId, event === 'Stop' ? 'idle' : 'failed', {});
  }

  /** A native frame from a Pretty manager: assistant tool_use blocks become tool events. */
  onNativeFrame(terminalId: string, frame: unknown): void {
    const f = frame as { type?: string; message?: { content?: unknown } };
    if (f?.type !== 'assistant' || !Array.isArray(f.message?.content)) return;
    for (const block of f.message!.content as { type?: string; name?: string; input?: unknown }[]) {
      if (block?.type === 'tool_use' && typeof block.name === 'string') this.onTool(terminalId, block.name, block.input);
    }
  }

  /** The harness event layer: turn start, usage and turn end for Pretty threads. */
  onHarnessEvent(e: HarnessEvent): void {
    const id = e.terminalId;
    if (e.type === 'turn.started') {
      this.turns.set(id, { startedAt: this.now(), input: 0, output: 0, cost: null, sawUsage: false });
    } else if (e.type === 'usage.observed') {
      const t = this.turns.get(id) ?? { startedAt: this.now(), input: 0, output: 0, cost: null, sawUsage: false };
      for (const m of e.measurements) {
        t.input += (m.input ?? 0) + (m.cacheRead ?? 0) + (m.cacheCreate ?? 0);
        t.output += m.output ?? 0;
        if (typeof m.reportedCostUsd === 'number') t.cost = (t.cost ?? 0) + m.reportedCostUsd;
        t.sawUsage = true;
      }
      this.turns.set(id, t);
    } else if (e.type === 'turn.completed') {
      this.closeTurn(id, e.outcome, { declared: e.detail.declared, summary: e.detail.summary });
    } else if (e.type === 'turn.failed') {
      this.closeTurn(id, 'failed', {});
    }
  }

  private closeTurn(terminalId: string, outcome: string, extra: { declared?: boolean; summary?: string }): void {
    const t = this.turns.get(terminalId);
    this.turns.delete(terminalId);
    const ms = t ? this.now() - t.startedAt : null;
    const partial = !t || !t.sawUsage;
    this.emit(terminalId, {
      type: 'thread:turn', ms, inputTokens: t?.sawUsage ? t.input : null, outputTokens: t?.sawUsage ? t.output : null, costUsd: t?.cost ?? null, outcome,
      ...(extra.declared !== undefined ? { declared: extra.declared } : {}), ...(extra.summary !== undefined ? { summary: extra.summary } : {}), ...(partial ? { partial: true } : {}),
    });
  }
}

/** The event for a plugin without `read:prompts`: no prompt text, no tool input; the sizes stay. */
export function redactThreadEvent(e: ThreadEvent): ThreadEvent {
  if (e.type === 'thread:prompt') { const { text: _t, ...rest } = e; return rest as ThreadEvent; }
  if (e.type === 'thread:tool') { const { input: _i, ...rest } = e; return rest as ThreadEvent; }
  return e;
}
