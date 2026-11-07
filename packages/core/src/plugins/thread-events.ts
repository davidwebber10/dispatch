import type { EventBroadcaster } from '../ws/events.js';
import type { HarnessEvent } from '../runtime/events.js';

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
  | (Base & { type: 'thread:prompt'; source: 'user' | 'coordinator' | 'thread' | 'hook'; text?: string; textLength: number })
  | (Base & { type: 'thread:tool'; tool: string; input?: unknown; inputLength: number })
  | (Base & { type: 'thread:turn'; ms: number | null; inputTokens: number | null; outputTokens: number | null; costUsd: number | null; outcome: string; declared?: boolean; summary?: string; partial?: boolean })
  | (Base & { type: 'thread:status'; state: 'done' | 'needs_you' | 'blocked'; summary: string; ask?: string; blocker?: string });

export type ThreadInfo = { sessionId: string; harness: string } | null;
type Subscriber = (e: ThreadEvent) => void;
/** An event body without the identity the emitter adds (distributes over the union). */
type Body = ThreadEvent extends infer E ? (E extends Base ? Omit<E, keyof Base> : never) : never;

interface OpenTurn { startedAt: number; input: number; output: number; cost: number | null; sawUsage: boolean }

export class ThreadEvents {
  private subscribers = new Set<Subscriber>();
  private turns = new Map<string, OpenTurn>();
  /** The last prompt text per thread within a short window: the hook and the route both report a Pretty prompt. */
  private lastPrompt = new Map<string, { text: string; at: number }>();

  constructor(private readonly broadcaster: EventBroadcaster, private readonly lookup: (terminalId: string) => ThreadInfo, private readonly now: () => number = Date.now) {}

  subscribe(fn: Subscriber): () => void { this.subscribers.add(fn); return () => { this.subscribers.delete(fn); }; }

  private emit(terminalId: string, body: Body): void {
    const info = this.lookup(terminalId);
    if (!info) return;
    const e = { terminalId, sessionId: info.sessionId, harness: info.harness, at: new Date(this.now()).toISOString(), ...body } as ThreadEvent;
    this.broadcaster.broadcast(e as unknown as Record<string, unknown>);
    for (const fn of this.subscribers) { try { fn(e); } catch (err) { console.warn('[plugins] a thread-event subscriber failed:', err instanceof Error ? err.message : err); } }
  }

  /** The user (or a peer) sent a prompt: from the session service, or from a hook's UserPromptSubmit. */
  onPrompt(terminalId: string, text: string, source: 'user' | 'coordinator' | 'thread' | 'hook'): void {
    const t = this.now();
    const last = this.lastPrompt.get(terminalId);
    if (last && last.text === text && t - last.at < 5000) return; // the same prompt, seen twice (route + hook)
    this.lastPrompt.set(terminalId, { text, at: t });
    if (!this.turns.has(terminalId)) this.turns.set(terminalId, { startedAt: t, input: 0, output: 0, cost: null, sawUsage: false });
    this.emit(terminalId, { type: 'thread:prompt', source, text, textLength: text.length });
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
    if (event === 'UserPromptSubmit' && typeof p.prompt === 'string') this.onPrompt(terminalId, p.prompt, 'user');
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
