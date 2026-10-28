/**
 * One Endless Chat turn (spec 2026-10-13 section 5; the gist section 6):
 *   wait (bounded) until every earlier message is summarized → render the view → log the
 *   message → spawn a fresh `claude -p --model opus` in the fixed folder → send
 *   [view][status][message] → log each reply, tool call and result as it arrives.
 * Messages sent while a turn runs reach the process between tool calls. Thinking is
 * streamed to the UI and never logged. Nothing carries over between turns but the log.
 */
import type { ContentBlock, IStructuredManager, PendingPermission } from '../structured/manager.js';
import type { EndlessMessage, EndlessStore } from './store.js';
import type { ViewKeeper } from './view-keeper.js';
import type { Compactor } from './compactor.js';
import type { LogInput } from './log.js';
import type { ZoomImage } from './recall.js';
import { endlessClaudeArgs, FIXED_CONTEXT_ENV, TURN_MODEL } from './claude-args.js';
import { clipToolOutput, messageLine } from './text.js';
import { usageOf, type Usage } from './summarizer.js';
import type { KeyHandle, KeyRegistry } from '../auth/principals.js';
import { untrustedBlock } from '../security/untrusted-text.js';

export const TURN_WAIT_MS = 30_000;
/** After a `result`, wait this long for more events (a queued message starts a second turn). */
export const RESULT_GRACE_MS = 1_500;
/** A result that leaves a handed-off message unanswered waits this long for the next result. */
export const HANDOFF_RESULT_CEILING_MS = 120_000;

export interface UserInput { text: string; project: string | null; media: string[] }
/** A message already in the log that a turn must answer: a thread's report (spec section 6.4). */
export interface LoggedInput { i: number; kind: 'work'; text: string; project: string | null }
type Pending = { logged: false; input: UserInput } | { logged: true; input: LoggedInput };
export type TurnStatus = 'idle' | 'waiting' | 'running' | 'failed' | 'interrupted';
export type EndlessEvent =
  | { type: 'endless:delta'; kind: 'text' | 'thinking'; text: string }
  | { type: 'endless:turn'; status: TurnStatus; error?: string };

export interface TurnDeps {
  store: EndlessStore;
  views: ViewKeeper;
  compactor: Compactor;
  manager: IStructuredManager;
  chatDir: string;
  mcpConfigPath: string;
  systemPrompt: () => string;
  statusBlock: (project: string | null) => string;
  projectName: (id: string | null) => string | null;
  log: (input: LogInput) => EndlessMessage[];
  emit: (e: EndlessEvent) => void;
  readImage: (file: string) => ZoomImage | null;
  onUsage?: (u: Usage) => void;
  waitMs?: number;
  graceMs?: number;
  handoffCeilingMs?: number;
  command?: string;
  commandArgs?: string[];
  /** The daemon's key registry, read at each turn (it can be set after construction). */
  keys?: () => KeyRegistry | undefined;
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b: any) => (b?.type === 'text' ? String(b.text ?? '') : b?.type === 'image' ? '[image]' : ''))
    .filter(Boolean)
    .join('\n');
}

/** A tool-call id for the `ref` column (pairs a call with its result); null if the CLI gave none. */
const idOrNull = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/**
 * Said once, to the model, at the top of a turn that a thread report started (outside the marked
 * block, so the report cannot forge or remove it). The tool set is fixed when the process starts.
 */
export const REPORT_TURN_NOTE =
  'This turn was started by a thread report, not by the user. You have no shell and no tools from ' +
  "the user's own servers or connectors in this turn; the Dispatch memory, thread and ledger tools " +
  'and your file tools work as usual. If the report needs a shell or a connector, tell the user ' +
  'what you need in your reply and end the turn: the next message from the user runs it.';

export class TurnRunner {
  private state: 'idle' | 'waiting' | 'running' = 'idle';
  private queued: Pending[] = [];
  /**
   * The running turn was started by a thread report: it has the reduced tool set (REPORT_TURN_NOTE).
   * A report never joins a turn that has the full set; it waits in `deferred` and starts its own turn.
   */
  private turnReduced = false;
  private deferred: LoggedInput[] = [];
  private turnId: string | null = null;
  private turnProject: string | null = null;
  private n = 0;
  private done: Promise<void> | null = null;
  /** A handed-off message has had no assistant or tool_result event since: its result is still owed. */
  private handoffPending = false;
  /** Set by watch(): lets a hand-off in the grace window switch to waiting for the next result. */
  private afterHandOff: (() => void) | null = null;
  /** Set by stop(): ends the current turn at once, in the wait or while the process runs. */
  private stopTurn: (() => void) | null = null;

  constructor(private readonly d: TurnDeps) {}

  get status(): 'idle' | 'waiting' | 'running' { return this.state; }

  whenIdle(): Promise<void> { return this.done ?? Promise.resolve(); }

  send(input: UserInput): void { this.accept({ logged: false, input }); }

  /**
   * A message the service already logged (a thread report). It starts a turn when Chat is idle,
   * joins a turn that is starting, or reaches the running process between tool calls. It is
   * never logged again.
   */
  deliver(input: LoggedInput): void { this.accept({ logged: true, input }); }

  private accept(p: Pending): void {
    // A report must not reach a process that has the user's shell and connectors. It is already
    // in the log; it waits here and starts its own (reduced) turn when this one ends.
    if (this.state !== 'idle' && p.logged && !this.turnReduced) { this.deferred.push(p.input); return; }
    if (this.state === 'running' && this.turnId) { this.handOff(p); return; }
    if (this.state === 'waiting') { this.queued.push(p); return; }
    this.start(p, true);
  }

  /**
   * Stop the turn that is waiting or running (the user's Stop button). The process is
   * killed; what it already said stays in the log. A message sent while it ran is logged
   * and not answered. Returns false when no turn runs.
   */
  stop(): boolean {
    if (this.state === 'idle' || !this.stopTurn) return false;
    this.stopTurn();
    return true;
  }

  /** Run the last user message again (it is already logged; it is not logged twice). */
  retry(): boolean {
    if (this.state !== 'idle') return false;
    const run = this.d.store.lastUserRun();
    if (!run.length) return false;
    this.start({ logged: false, input: { text: run.map((m) => m.text).join(''), project: run[0].project, media: run.flatMap((m) => m.media) } }, false);
    return true;
  }

  private start(first: Pending, logIt: boolean): void {
    this.state = 'waiting';
    this.turnReduced = first.logged;
    this.turnProject = first.input.project;
    this.handoffPending = false;
    this.d.emit({ type: 'endless:turn', status: 'waiting' });
    const done: Promise<void> = this.run(first, logIt).finally(() => { if (this.done === done) this.done = null; });
    this.done = done;
  }

  private content(p: Pending, before: string[]): ContentBlock[] {
    const blocks: ContentBlock[] = before.map((text) => ({ type: 'text', text }));
    // A thread's report is text that a hostile page or pull request may have shaped: it goes to the model as data.
    const text = p.logged ? untrustedBlock('a thread report', p.input.text) : p.input.text;
    blocks.push({ type: 'text', text: messageLine(p.logged ? p.input.kind : 'user', text, this.d.projectName(p.input.project)) });
    if (!p.logged) {
      for (const file of p.input.media) {
        const img = this.d.readImage(file);
        if (img) blocks.push({ type: 'image', source: { type: 'base64', media_type: img.mimeType, data: img.data } });
      }
    }
    return blocks;
  }

  /** Log a user message; returns the index of its first row. */
  private logUser(input: UserInput): number {
    return this.d.log({ kind: 'user', text: input.text, project: input.project, media: input.media })[0]?.i ?? this.d.store.count();
  }

  /** Send a message to the running process. `logIt` false: the caller already logged it. */
  private handOff(p: Pending, logIt = true): void {
    if (logIt && !p.logged) this.logUser(p.input);
    this.handoffPending = true;
    this.afterHandOff?.();
    this.d.manager.sendMessage(this.turnId!, this.content(p, []));
  }

  private async run(first: Pending, logIt: boolean): Promise<void> {
    const d = this.d;
    let error: string | undefined;
    let cancel: (() => void) | null = null;
    let stopped = false;
    let keyHandle: KeyHandle | null = null;
    let onStop!: () => void;
    const stopSignal = new Promise<void>((r) => { onStop = r; });
    this.stopTurn = () => { stopped = true; onStop(); };
    try {
      const upTo = first.logged ? first.input.i : d.store.count();
      await Promise.race([d.compactor.waitForSettled(upTo, d.waitMs ?? TURN_WAIT_MS), stopSignal]);
      if (stopped) {
        // Stopped before the message was logged: log it, so that it is not lost.
        if (logIt && !first.logged) this.logUser(first.input);
        return;
      }
      // A report logged while this turn waited is a message of this turn (or of the turn after it), not a view line.
      const cut = Math.min(first.logged ? first.input.i : d.store.count(), ...this.queued.flatMap((q) => (q.logged ? [q.input.i] : [])), ...this.deferred.map((r) => r.i));
      const view = d.views.turnBlocks(cut);          // render the view first …
      const status = d.statusBlock(first.input.project);
      // … then log every user message of this turn, so that each message has its log index.
      // The model receives the messages in log order: a report logged during the wait comes
      // before a user message that is logged now. A retried message is already logged (-1: first).
      const order: { p: Pending; at: number }[] = [];
      order.push({ p: first, at: first.logged ? first.input.i : logIt ? this.logUser(first.input) : -1 });
      while (this.queued.length) {
        const q = this.queued[0];
        const at = q.logged ? q.input.i : this.logUser(q.input);
        this.queued.shift(); // only after it is logged: a failed log leaves it for `finally`
        order.push({ p: q, at });
      }
      order.sort((a, b) => a.at - b.at);
      const id = `endless-turn-${++this.n}-${Date.now()}`;
      this.turnId = id;
      const w = this.watch(id);
      cancel = w.cancel;
      const keys = d.keys?.();
      const minted = keys?.mint({ kind: 'chat', startedBy: first.logged ? 'report' : 'user' });
      if (minted) keyHandle = minted.handle;
      d.manager.spawn(id, {
        command: d.command ?? 'claude',
        args: [...(d.commandArgs ?? []), ...endlessClaudeArgs({ model: TURN_MODEL, systemPrompt: d.systemPrompt(), mcpConfigPath: d.mcpConfigPath, userTools: true, reportTurn: this.turnReduced })],
        workDir: d.chatDir,
        env: minted ? { ...FIXED_CONTEXT_ENV, DISPATCH_AUTH: minted.key } : FIXED_CONTEXT_ENV,
      });
      this.state = 'running';
      d.emit({ type: 'endless:turn', status: 'running' });
      d.manager.sendMessage(id, this.content(order[0].p, [...view, status, ...(this.turnReduced ? [REPORT_TURN_NOTE] : [])]));
      for (const o of order.slice(1)) this.handOff(o.p, false);
      const result = await Promise.race([w.ended, stopSignal.then(() => null)]);
      if (result) error = result.error;
    } catch (err) {
      if (!stopped) error = err instanceof Error ? err.message : String(err);
    } finally {
      this.stopTurn = null;
      cancel?.();
      const id = this.turnId;
      try {
        if (id && d.manager.isAlive(id)) d.manager.kill(id);
      } catch { /* the process is gone or unkillable; the turn still ends */ }
      if (keyHandle) d.keys?.()?.revoke(keyHandle);
      try {
        // User messages that never reached the log are logged so that they are not lost.
        // Reports are already in the log; the next turn sees them in its view (no auto-retry).
        for (const q of this.queued.splice(0)) if (!q.logged) this.logUser(q.input);
      } catch (err) {
        error ??= err instanceof Error ? err.message : String(err);
      }
      this.turnId = null;
      this.handoffPending = false;
      this.state = 'idle';
      if (stopped) error = undefined; // a stop is not a failure, even when the kill makes the process fail
      d.emit(error ? { type: 'endless:turn', status: 'failed', error } : { type: 'endless:turn', status: 'idle' });
      this.startDeferred(stopped);
    }
  }

  /**
   * Reports that came in during a turn with the full tool set start their own turn now. After a
   * Stop they stay in the log only (the next turn's view shows them): the user said stop.
   */
  private startDeferred(stopped: boolean): void {
    const next = this.deferred.splice(0);
    if (stopped || !next.length || this.state !== 'idle') return;
    try {
      this.start({ logged: true, input: next[0] }, true);
      for (const input of next.slice(1)) this.queued.push({ logged: true, input });
    } catch (err) {
      console.warn('[endless] a report that waited could not start its turn:', err);
    }
  }

  /**
   * Follow one turn process until it is done. `ended` resolves at a `result` plus the grace
   * window, or when the process exits or fails. `cancel` detaches every listener and timer
   * (the run calls it in `finally`, so a throw after watch() leaks nothing).
   *
   * A message handed off after the turn's last assistant / tool_result event may run as a
   * second CLI turn after the first `result`, and its first event can come later than the
   * grace window. So a `result` with such a hand-off pending waits for the next `result`
   * (up to HANDOFF_RESULT_CEILING_MS) instead of starting the grace window.
   */
  private watch(id: string): { ended: Promise<{ error?: string }>; cancel: () => void } {
    const d = this.d;
    const m = d.manager;
    let timer: NodeJS.Timeout | null = null;
    let phase: 'working' | 'grace' | 'ceiling' = 'working';
    let sawResult = false;
    let failure: string | undefined;
    let settled = false;
    let resolve!: (v: { error?: string }) => void;
    const ended = new Promise<{ error?: string }>((r) => { resolve = r; });
    const ceilingMs = d.handoffCeilingMs ?? HANDOFF_RESULT_CEILING_MS;
    const clear = () => { if (timer) { clearTimeout(timer); timer = null; } };
    const detach = () => {
      clear();
      m.off('event', onEvent);
      m.off('exit', onExit);
      m.off('failed', onFailed);
      m.off('permission', onPermission);
      if (this.afterHandOff === onHandOff) this.afterHandOff = null;
    };
    const finish = (error?: string) => {
      if (settled) return;
      settled = true;
      detach();
      resolve({ error });
    };
    const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
    const waitForNextResult = () => {
      clear();
      this.handoffPending = false; // this wait now covers it
      phase = 'ceiling';
      timer = setTimeout(() => finish(`no reply to a message sent during the turn within ${Math.round(ceilingMs / 1000)} s`), ceilingMs);
    };
    const onHandOff = () => { if (phase !== 'working') waitForNextResult(); };
    const onEvent = (tid: string, ev: any) => {
      if (tid !== id || settled) return;
      try {
        const toolResult = ev?.type === 'user' && Array.isArray(ev.message?.content) && ev.message.content.some((b: any) => b?.type === 'tool_result');
        // Our own user-message echo is not progress: it must not cancel the grace or ceiling timer.
        const echo = ev?.type === 'user' && !toolResult;
        if (!echo) { clear(); phase = 'working'; }
        this.record(ev);
        if (ev?.parent_tool_use_id == null && (ev?.type === 'assistant' || toolResult)) this.handoffPending = false;
        if (ev?.type === 'result') {
          sawResult = true;
          failure = ev.is_error ? String(ev.result || ev.subtype || 'the turn failed') : undefined;
          const u = usageOf(ev.usage);
          if (u) d.onUsage?.(u);
          if (this.handoffPending) waitForNextResult();
          else { phase = 'grace'; timer = setTimeout(() => finish(failure), d.graceMs ?? RESULT_GRACE_MS); }
        }
      } catch (err) {
        finish(`the turn could not record an event: ${message(err)}`);
      }
    };
    const onExit = (tid: string, code: number) => {
      if (tid !== id) return;
      if (phase === 'ceiling' || this.handoffPending) finish(`the turn process exited (code ${code}) before it answered a message sent during the turn`);
      else finish(sawResult ? failure : `the turn process exited (code ${code}) before it finished`);
    };
    const onFailed = (tid: string) => { if (tid === id && !sawResult) finish('the turn process failed'); };
    const onPermission = (tid: string, p: PendingPermission) => {
      if (tid !== id || settled) return;
      try {
        m.answerPermission(id, p.requestId, { behavior: 'deny', message: 'Ask the user in your reply instead, then end your turn.' });
      } catch (err) {
        finish(`the turn could not answer a permission request: ${message(err)}`);
      }
    };
    m.on('event', onEvent);
    m.on('exit', onExit);
    m.on('failed', onFailed);
    m.on('permission', onPermission);
    this.afterHandOff = onHandOff;
    return { ended, cancel: () => { if (!settled) { settled = true; detach(); } } };
  }

  private record(ev: any): void {
    const d = this.d;
    if (ev?.parent_tool_use_id != null) return; // a sub-agent's own steps stay out of the log
    const project = this.turnProject;
    if (ev?.type === 'stream_event') {
      const delta = ev.event?.type === 'content_block_delta' ? ev.event.delta : null;
      if (delta?.type === 'text_delta' && delta.text) d.emit({ type: 'endless:delta', kind: 'text', text: delta.text });
      if (delta?.type === 'thinking_delta' && delta.thinking) d.emit({ type: 'endless:delta', kind: 'thinking', text: delta.thinking });
      return;
    }
    if (ev?.type === 'assistant' && Array.isArray(ev.message?.content)) {
      // The CLI's own error notices (login expired, rate limit) come as assistant messages
      // from the model "<synthetic>". They are not Dispatch's words: the turn's failure
      // shows them, and the log stays clean for the summaries.
      if (ev.isApiErrorMessage || ev.message?.model === '<synthetic>') return;
      for (const b of ev.message.content) {
        if (b?.type === 'text' && String(b.text ?? '').trim()) d.log({ kind: 'unii', text: b.text, project });
        else if (b?.type === 'tool_use') d.log({ kind: 'tool', text: `${b.name} ${JSON.stringify(b.input ?? {})}`, project, ref: idOrNull(b.id) });
        // thinking blocks: streamed above, never logged
      }
      return;
    }
    if (ev?.type === 'user' && Array.isArray(ev.message?.content)) {
      for (const b of ev.message.content) {
        if (b?.type === 'tool_result') d.log({ kind: 'echo', text: clipToolOutput(toolResultText(b.content)), project, ref: idOrNull(b.tool_use_id) });
      }
    }
  }
}
