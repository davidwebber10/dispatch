// packages/core/src/structured/shared/subagents.ts
//
// Subagents of a structured thread (capability `subagents-v1`). A subagent is an agent that the
// thread's main agent (or another subagent) starts: a Claude Code `Agent`/`Task` call, a Codex
// sub-thread (`spawn_agent`). Its frames reach the thread's stream with `parent_tool_use_id` = the
// subagent's id; this file keeps the list of them and their state, the same for both harnesses:
//
//   - one `SubagentTracker` per live session (the manager owns it);
//   - each state change writes one `{type:'system', subtype:'subagent', …}` frame into the thread
//     (the journal keeps it as a `notice`), so a view needs no per-harness rules;
//   - the thread stays `working` while a subagent runs: the manager holds the `idle` of a main turn
//     that ends while one runs (`holdIdle`), and lets it go when the last one ends, unless a new main
//     turn started in the meantime (the harness woke the main agent with the result).
//
// Ids: Claude: the `Agent` call's tool_use id. Codex: the sub-thread id (`agentThreadId`).

/** `lost`: no frame of it came for a long time while the main turn was over (see TrackerOptions.lostAfterMs). */
export type SubagentState = 'starting' | 'working' | 'needs_input' | 'failed' | 'stopped' | 'done' | 'lost';
export type SubagentHarness = 'claude-code' | 'codex';

/** The states of a subagent that still runs (it keeps the thread `working`). */
export const RUNNING_STATES: ReadonlySet<SubagentState> = new Set(['starting', 'working', 'needs_input']);

export interface SubagentInfo {
  id: string;
  /** The subagent that started this one (nesting), or null when the main agent did. */
  parentId: string | null;
  harness: SubagentHarness;
  title: string;
  /** Claude `subagent_type`; Codex agent role. */
  kind?: string;
  prompt?: string;
  model?: string;
  effort?: string;
  state: SubagentState;
  /** Epoch ms. */
  startedAt?: number;
  endedAt?: number;
  usage?: { input?: number; output?: number };
  tokens?: number;
  /** Tool calls the subagent made. */
  steps?: number;
  /** The final text (without Claude's trailing "agentId: … SendMessage" line). */
  result?: string;
  error?: string;
  /** Claude: the agent runs after its call returned (`run_in_background`, or the CLI chose it). */
  background?: boolean;
  /** The main-thread item that shows it (Claude: the call id = `id`; Codex: the first subAgentActivity item). */
  callId?: string;
  /** The harness's own id for it: Claude's `agentId`/`task_id`; Codex: the sub-thread's agent path. */
  nativeId?: string;
  /** Epoch ms of its last frame (any), for the time limit of a held idle. */
  lastSeenAt?: number;
}

/** The longest prompt or result a lifecycle frame carries (the agent journal has the whole text). */
const MAX_TEXT = 8000;

function clip(s: string | undefined): string | undefined {
  if (typeof s !== 'string') return undefined;
  return s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT)}…` : s;
}

/** The lifecycle frame of one subagent, as it goes into the thread's stream and journal. */
export function subagentFrame(info: SubagentInfo): Record<string, unknown> {
  const out: Record<string, unknown> = { type: 'system', subtype: 'subagent' };
  for (const [k, v] of Object.entries(info)) {
    if (v === undefined) continue;
    out[k] = k === 'prompt' || k === 'result' || k === 'error' ? clip(v as string) : v;
  }
  return out;
}

/** True for a `{type:'system', subtype:'subagent'}` frame. */
export function isSubagentFrame(e: unknown): e is Record<string, unknown> & { id: string } {
  const f = e as { type?: unknown; subtype?: unknown; id?: unknown } | null;
  return !!f && f.type === 'system' && f.subtype === 'subagent' && typeof f.id === 'string';
}

/** A readable title from a Codex agent path: `/root/independent_file_review` → "Independent file review". */
export function titleFromAgentPath(agentPath: unknown): string | undefined {
  if (typeof agentPath !== 'string' || !agentPath) return undefined;
  const last = agentPath.split('/').filter(Boolean).pop();
  if (!last || last === 'root') return undefined;
  const words = last.replace(/[_-]+/g, ' ').trim();
  return words ? words[0].toUpperCase() + words.slice(1) : undefined;
}

/** Claude's tool_result of an `Agent` call ends with "agentId: … (use SendMessage …)": not the agent's words. */
export function stripAgentIdLine(text: string): string {
  return text
    .split('\n')
    .filter((l) => !/^\s*agentId:\s*\S+/.test(l))
    .join('\n')
    .replace(/<tools-used-before-summary>[\s\S]*?<\/tools-used-before-summary>\s*/g, '')
    .trim();
}

/** The text of a tool_result `content` (a string, or text blocks). */
export function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((b) => b && typeof b === 'object' && (b as { type?: unknown }).type === 'text')
    .map((b) => String((b as { text?: unknown }).text ?? '')).join('\n');
}

/** What a stop of one subagent did. */
export type StopAgentResult = 'stopped' | 'not-found' | 'not-running' | 'unsupported';

/**
 * The input that hands a finished subagent's result to the main agent (Codex: the daemon starts that
 * turn; Claude Code does it by itself). The shape is Claude Code's own `<task-notification>` block, so
 * every reader shows it as a notice, never as the person's message (conversation/task-notification.ts).
 */
export function subagentResultText(r: { id: string; title: string; state: SubagentState; text: string }): string {
  const status = r.state === 'done' ? 'completed' : r.state === 'failed' ? 'failed' : 'killed';
  const verb = r.state === 'done' ? 'completed' : r.state === 'failed' ? 'could not finish' : 'was stopped';
  // Model output goes inside a block a reader parses: no `<` of its own may open or close a tag.
  const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  let text = r.text.trim();
  if (text.length > MAX_HANDBACK) text = `${text.slice(0, MAX_HANDBACK)}\n… (cut: the whole text is in the agent's journal)`;
  if (!text) text = r.state === 'done' ? 'The subagent finished without a final message.' : 'The subagent gave no reason.';
  return [
    '<task-notification>',
    `<task-id>${esc(r.id)}</task-id>`,
    `<tool-use-id>${esc(r.id)}</tool-use-id>`,
    `<status>${status}</status>`,
    `<summary>Agent "${esc(r.title).slice(0, 120)}" ${verb}</summary>`,
    '<note>Subagent hand-back from Dispatch: the result below is the output of a subagent, NOT a message from the person.</note>',
    `<result>${esc(text)}</result>`,
    '</task-notification>',
  ].join('\n');
}

/** The longest result text handed back to the main agent. */
const MAX_HANDBACK = 16_000;

export interface TrackerOptions {
  /** Write one frame into the thread (ring, journal, viewers). */
  emit: (frame: Record<string, unknown>) => void;
  /** How long to wait, after the last subagent ended, for the harness to start a main turn by itself (Claude wakes). */
  releaseDelayMs?: number;
  /**
   * The time limit of a held idle (default 30 min): when no running subagent sent a frame for this long,
   * and none waits for the person, they are marked `lost` and the idle is let go. The thread then
   * reads idle again (a box may sleep), instead of `working` for ever.
   */
  lostAfterMs?: number;
  now?: () => number;
}

/**
 * The subagents of one session, and the held `idle` of its main turn (see the file comment).
 * Never throws out of a manager's frame loop: callers pass plain data.
 */
export class SubagentTracker {
  private agents = new Map<string, SubagentInfo>();
  private order: string[] = [];
  private held: (() => void) | null = null;
  private releaseTimer: ReturnType<typeof setTimeout> | null = null;
  private lostTimer: ReturnType<typeof setInterval> | null = null;
  private readonly now: () => number;

  constructor(readonly harness: SubagentHarness, private readonly opts: TrackerOptions) {
    this.now = opts.now ?? Date.now;
  }

  get(id: string): SubagentInfo | undefined { return this.agents.get(id); }
  has(id: string): boolean { return this.agents.has(id); }
  /** Oldest first. Copies. */
  list(): SubagentInfo[] { return this.order.map((id) => ({ ...this.agents.get(id)! })); }
  running(): SubagentInfo[] { return this.list().filter((a) => RUNNING_STATES.has(a.state)); }
  isRunning(id: string): boolean { const a = this.agents.get(id); return !!a && RUNNING_STATES.has(a.state); }

  /**
   * Create a subagent (state `starting` unless `init.state` says more), or merge `init` into one we
   * know. A new one writes its frame. Returns the record.
   */
  ensure(id: string, init: Partial<SubagentInfo> = {}): SubagentInfo {
    const known = this.agents.get(id);
    if (known) {
      // Fill what was not known yet (the call can come after the first frame of its stream); never re-start.
      for (const [k, v] of Object.entries(init)) {
        if (k === 'state' || v === undefined) continue;
        const cur = (known as unknown as Record<string, unknown>)[k];
        if (cur === undefined || (k === 'title' && cur === 'Agent')) (known as unknown as Record<string, unknown>)[k] = v;
      }
      return known;
    }
    const info: SubagentInfo = { parentId: null, harness: this.harness, title: 'Agent', ...stripUndefined(init), id, state: init.state ?? 'starting' };
    info.startedAt ??= this.now();
    info.lastSeenAt = this.now();
    this.agents.set(id, info);
    this.order.push(id);
    this.cancelRelease();
    this.opts.emit(subagentFrame(info));
    return info;
  }

  /**
   * Change a subagent. A change of state writes its frame (an end sets `endedAt`); other fields
   * change quietly (the next frame carries them). `force` writes a frame with no state change.
   * An ended subagent never runs again, except through `revive` (Claude continues an agent with
   * SendMessage; Codex sends input to a finished sub-thread).
   */
  update(id: string, patch: Partial<SubagentInfo>, opts: { force?: boolean; revive?: boolean } = {}): SubagentInfo | undefined {
    const a = this.agents.get(id);
    if (!a) return undefined;
    const before = a.state;
    const ended = !RUNNING_STATES.has(before);
    const next = patch.state;
    if (next && ended && RUNNING_STATES.has(next) && !opts.revive) {
      // A late frame of a finished subagent: keep its end.
      const { state: _s, ...rest } = patch;
      Object.assign(a, stripUndefined(rest));
      return a;
    }
    Object.assign(a, stripUndefined(patch));
    if (changed0(next, before)) a.lastSeenAt = this.now();
    if (next && !RUNNING_STATES.has(next) && RUNNING_STATES.has(before)) a.endedAt ??= this.now();
    if (next && RUNNING_STATES.has(next) && ended) a.endedAt = undefined;
    const changed = next !== undefined && next !== before;
    if (changed || opts.force) this.opts.emit(subagentFrame(a));
    if (changed && !RUNNING_STATES.has(a.state)) this.maybeRelease();
    if (changed && RUNNING_STATES.has(a.state)) this.cancelRelease();
    return a;
  }

  /** A frame of this subagent came: it is alive (the time limit of a held idle starts again). Quiet. */
  touch(id: string): void {
    const a = this.agents.get(id);
    if (a) a.lastSeenAt = this.now();
  }

  /** Add one to a subagent's step count (a tool call it made). Quiet. */
  step(id: string): void {
    const a = this.agents.get(id);
    if (a) a.steps = (a.steps ?? 0) + 1;
  }

  /**
   * The main turn ended while subagents run: keep the thread `working`. `settle` is what the turn
   * end would have done (emit `idle`); it runs when the last subagent ends, unless `turnStarted`
   * came first. Returns false (and holds nothing) when no subagent runs: the caller settles now.
   */
  holdIdle(settle: () => void): boolean {
    if (this.running().length === 0) return false;
    this.held = settle;
    this.armLost();
    return true;
  }

  /**
   * While an idle is held, check now and then that a running subagent still sends frames. One that
   * waits for the person is alive (its request is in front of the person); with none of those and no
   * frame from any running one for `lostAfterMs`, they are `lost` and the idle goes.
   */
  private armLost(): void {
    if (this.lostTimer) return;
    const limit = this.opts.lostAfterMs ?? 30 * 60_000;
    this.lostTimer = setInterval(() => this.checkLost(limit), Math.max(10, Math.min(60_000, Math.floor(limit / 4))));
    this.lostTimer.unref?.();
  }

  /** The check of armLost (a test may call it). */
  checkLost(limit = this.opts.lostAfterMs ?? 30 * 60_000): void {
    if (!this.held) { this.disarmLost(); return; }
    const running = this.running();
    if (running.some((a) => a.state === 'needs_input')) return;
    const newest = Math.max(0, ...running.map((a) => a.lastSeenAt ?? a.startedAt ?? 0));
    if (this.now() - newest < limit) return;
    const minutes = Math.max(1, Math.round(limit / 60_000));
    for (const a of running) this.update(a.id, { state: 'lost', error: `No word from the subagent for ${minutes} min.` });
  }

  private disarmLost(): void {
    if (this.lostTimer) clearInterval(this.lostTimer);
    this.lostTimer = null;
  }

  /** True while a held main-turn end waits for the subagents. */
  holding(): boolean { return this.held !== null; }

  /** A main turn started: a held end belongs to a turn that is over, and is dropped. */
  turnStarted(): void {
    this.held = null;
    this.cancelRelease();
    this.disarmLost();
  }

  /** The session ended: forget timers (a held end is dropped; the exit settles the thread). */
  dispose(): void {
    this.held = null;
    this.cancelRelease();
    this.disarmLost();
  }

  /** Every running subagent ends as `stopped` (the session ended, or the main turn was stopped). */
  stopAll(reason?: string, filter: (a: SubagentInfo) => boolean = () => true): SubagentInfo[] {
    const out: SubagentInfo[] = [];
    for (const a of this.running()) {
      if (!filter(a)) continue;
      const u = this.update(a.id, { state: 'stopped', ...(reason ? { error: reason } : {}) });
      if (u) out.push(u);
    }
    return out;
  }

  private maybeRelease(): void {
    if (!this.held || this.running().length > 0) return;
    this.cancelRelease();
    const delay = this.opts.releaseDelayMs ?? 0;
    const release = () => {
      this.releaseTimer = null;
      const settle = this.held;
      this.held = null;
      this.disarmLost();
      if (settle && this.running().length === 0) settle();
    };
    if (delay <= 0) { release(); return; }
    this.releaseTimer = setTimeout(release, delay);
    this.releaseTimer.unref?.();
  }

  private cancelRelease(): void {
    if (this.releaseTimer) clearTimeout(this.releaseTimer);
    this.releaseTimer = null;
  }
}

function changed0(next: SubagentState | undefined, before: SubagentState): boolean { return next !== undefined && next !== before; }

function stripUndefined<T extends object>(o: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  return out;
}
