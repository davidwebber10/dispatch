/**
 * Endless Chat composition root: one store, one view keeper, one compactor, one turn
 * runner, the memory MCP config, saved images, and the events-socket broadcasts.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';
import type { EventBroadcaster } from '../ws/events.js';
import type { IStructuredManager } from '../structured/manager.js';
import * as sessionsDb from '../db/sessions.js';
import * as terminalsDb from '../db/terminals.js';
import { EndlessStore, type EndlessMessage, type Page } from './store.js';
import { ViewKeeper } from './view-keeper.js';
import { Compactor } from './compactor.js';
import { TurnRunner, type EndlessEvent, type TurnStatus } from './turn-runner.js';
import { appendLogged, type LogInput, type LogOptions } from './log.js';
import { reportText, threadOrigin, recoveryOutcome, pendingQuestionText, type PendingPrompt } from './reports.js';
import { createSummarizer } from './summarizer-choice.js';
import type { Summarizer, Usage } from './summarizer.js';
import { systemPromptWith } from './prompt.js';
import { buildStatusBlock, collectProjects, type ProjectStatus } from './status-block.js';
import { zoom, dateOf, readImage, RecallError, type ZoomImage } from './recall.js';
import { importOnce } from './import.js';
import { DEFAULT_LIMITS, type ViewLimits } from './view.js';
import { nodeName } from './tree.js';
import { resolveProject, overseerOf, type ProjectRef } from './projects.js';
import type { LedgerService } from '../overseer/ledger-service.js';

export class UserError extends Error {}

export type WireMessage = Omit<EndlessMessage, 'media'> & { media: string[]; projectName: string | null };

const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** `DISPATCH_ENDLESS_LIMITS=low,high,compactionLow,compactionHigh` (end-to-end checks only). */
export function limitsFromEnv(raw?: string): ViewLimits {
  const n = (raw ?? '').split(',').map((s) => Number(s.trim()));
  if (n.length !== 4 || n.some((x) => !Number.isFinite(x) || x <= 0)) return DEFAULT_LIMITS;
  return { low: n[0], high: n[1], compactionLow: n[2], compactionHigh: n[3] };
}

export interface EndlessServiceOptions {
  db: Database.Database;
  broadcaster: EventBroadcaster;
  manager: IStructuredManager;
  chatDir: string;
  home: string;
  summarizer?: Summarizer;
  limits?: ViewLimits;
  timeZone?: string;
  now?: () => number;
  openRouterKey?: () => Promise<string | null>;
  turn?: { waitMs?: number; graceMs?: number; command?: string; commandArgs?: string[] };
  /** A thread's final output for its report (SessionService.finalOutput). */
  finalOutput?: (terminalId: string) => string;
  /** The question or gated tool a thread waits on (SessionService.getPendingPermission). */
  pendingPermission?: (terminalId: string) => PendingPrompt | null;
  /** The daemon's ledger service: Chat acts as a project's overseer through it. */
  ledger?: LedgerService;
}

export class EndlessService {
  readonly store: EndlessStore;
  readonly views: ViewKeeper;
  readonly compactor: Compactor;
  readonly turns: TurnRunner;
  readonly mediaDir: string;
  readonly mcpConfigPath: string;
  private readonly timeZone: string;
  private readonly now: () => number;
  /** 'new' until start(); 'failed' if start() threw (the chat routes then answer 503). */
  private phase: 'new' | 'ready' | 'failed' = 'new';
  private readonly usage: { turns: Usage[]; compactions: Usage[] } = { turns: [], compactions: [] };
  /** Threads with a settle edge scheduled this tick: one ending claims at most one report. */
  private readonly settling = new Set<string>();
  /**
   * Threads that owed a report when their last status edge was 'error': a repeated error edge
   * is the same ending. Only threads with a pending report enter, so the set stays bounded.
   */
  private readonly errored = new Set<string>();

  constructor(private readonly o: EndlessServiceOptions) {
    this.store = new EndlessStore(o.db);
    this.views = new ViewKeeper(this.store, o.limits, { defer: true });
    this.mediaDir = path.join(o.chatDir, 'media');
    this.mcpConfigPath = path.join(o.chatDir, 'memory.mcp.json');
    this.timeZone = o.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    this.now = o.now ?? Date.now;
    const summarizer = o.summarizer ?? createSummarizer({
      manager: o.manager, chatDir: o.chatDir, mcpConfigPath: this.mcpConfigPath,
      openRouterKey: o.openRouterKey ?? (async () => null), onUsage: (u) => this.note('compactions', u),
    });
    this.compactor = new Compactor({
      store: this.store, views: this.views, summarizer,
      systemPrompt: () => this.systemPrompt(), projectName: (id) => this.projectName(id),
      onFailed: (ref, error) => console.warn(`[endless] compaction ${nodeName(ref.l, ref.i)} failed: ${error}`),
    });
    this.turns = new TurnRunner({
      store: this.store, views: this.views, compactor: this.compactor, manager: o.manager,
      chatDir: o.chatDir, mcpConfigPath: this.mcpConfigPath,
      systemPrompt: () => this.systemPrompt(),
      statusBlock: (project) => buildStatusBlock(collectProjects(o.db, this.store), { now: this.now(), timeZone: this.timeZone, projectId: project }),
      projectName: (id) => this.projectName(id),
      log: (input) => this.log(input),
      emit: (e) => this.emit(e),
      readImage,
      onUsage: (u) => this.note('turns', u),
      ...o.turn,
    });
  }

  /** After the daemon listens: the MCP config, a stopped turn marked, recovery, the one-time import. */
  start(port: number): void {
    // recover() replaces the compactor's unbuilt list: a second call would lose work.
    if (this.phase !== 'new') return;
    try {
      this.boot(port);
      this.phase = 'ready';
      // After compactor.recover() (in boot): a report that recovery logs starts a turn.
      this.recoverReports();
    } catch (err) {
      this.phase = 'failed';
      this.compactor.stop();
      throw err;
    }
  }

  /** True after a successful start(); the routes refuse every request until then. */
  get available(): boolean { return this.phase === 'ready'; }

  /**
   * During daemon shutdown the DB closes before the killed turn's `finally` (a microtask
   * after the synchronous 'exit') runs. Writes then return early; turn_status keeps its
   * running/waiting value, so the next boot marks the turn interrupted.
   */
  private get closed(): boolean { return !this.o.db.open; }

  private boot(port: number): void {
    // Loaded here, not in the constructor: a corrupt saved view then fails only the chat.
    this.views.load();
    fs.mkdirSync(this.mediaDir, { recursive: true });
    const memoryMcp = fileURLToPath(new URL('./memory-mcp.js', import.meta.url));
    fs.writeFileSync(this.mcpConfigPath, JSON.stringify({ mcpServers: { memory: { command: 'node', args: [memoryMcp], env: { DISPATCH_PORT: String(port) } } } }, null, 2));
    const last = this.store.getState('turn_status');
    if (last === 'running' || last === 'waiting') this.store.setState('turn_status', 'interrupted');
    this.compactor.recover();
    importOnce({ db: this.o.db, store: this.store, home: this.o.home, log: (input) => this.log(input) });
  }

  stop(): void { this.compactor.stop(); }

  systemPrompt(): string { return systemPromptWith(this.instructions()); }
  instructions(): string { return this.store.getState('instructions') ?? ''; }
  setInstructions(text: string): void { this.store.setState('instructions', text); }

  projectName(id: string | null): string | null {
    return id ? sessionsDb.getById(this.o.db, id)?.name ?? null : null;
  }

  /** A project by name or id, for the thread tools; UserError when unknown or ambiguous. */
  project(ref: string): ProjectRef {
    const r = resolveProject(sessionsDb.list(this.o.db), ref);
    if (!r.ok) throw new UserError(r.error);
    return r.project;
  }

  /**
   * The ledger tools for Chat. The ledger belongs to the project's Control Plane (only its
   * overseer writes, and quotes are checked against its user messages), so Chat acts as that
   * overseer, for the actions that need no quote of the user.
   */
  ledger(action: string, body: Record<string, unknown>): unknown {
    const ledger = this.o.ledger;
    if (!ledger) throw new UserError('the ledger is not available');
    const { project: ref, ...args } = body;
    const p = this.project(typeof ref === 'string' ? ref : '');
    const overseer = overseerOf(this.o.db, p.id);
    if (!overseer) throw new UserError(`${p.name} has no Control Plane, and its ledger belongs to it. Ask the user to open the project's Control Plane once.`);
    switch (action) {
      case 'list': {
        const r = ledger.list(p.id, overseer, { forRecap: false });
        return { text: r.text, openIds: r.openIds, rules: r.rules };
      }
      case 'show': return ledger.show(p.id, overseer, args);
      case 'add': {
        const source = args.source as { kind?: unknown } | null | undefined;
        if (source && typeof source === 'object' && source.kind === 'user') {
          throw new UserError('Chat cannot record an item with a user source: it has no quote of the user. Use another source kind, or ask the user to add it in the project\'s Control Plane.');
        }
        return ledger.add(p.id, overseer, { ...args, author: 'chat' });
      }
      case 'resolve':
        if (args.status !== 'withdrawn') {
          throw new UserError('Chat can only withdraw an item (status "withdrawn", with a reason). The user answers or parks items in the project\'s Control Plane.');
        }
        return ledger.resolve(p.id, overseer, args);
      case 'title': return ledger.setTitle(p.id, overseer, args);
      default: throw new UserError(`unknown ledger action: ${action}`);
    }
  }

  /** Chat sent work to a thread it started: the thread then owes Chat one more report. */
  arm(terminalId: string): { armed: boolean } {
    const t = terminalsDb.getById(this.o.db, terminalId);
    if (!t) throw new UserError(`unknown thread: ${terminalId}`);
    if (threadOrigin(t) !== 'endless') throw new UserError(`not a Chat thread: ${terminalId}`);
    this.store.armReport(terminalId, this.now());
    return { armed: true };
  }

  /** The send of an armed job failed: take back the one report that arm owed. */
  disarm(terminalId: string): { disarmed: boolean } {
    return { disarmed: this.store.claimReport(terminalId) };
  }

  /**
   * Every status edge of a thread (StatusService onWatchStatus). Only the edge INTO 'error'
   * reports (a crash; the settled listener never fires for it); a repeated error edge with no
   * other status between (a hook error, then the process exit) is the same ending.
   */
  onThreadStatus(terminalId: string, status: string): void {
    if (status !== 'error') { this.errored.delete(terminalId); return; }
    if (this.errored.has(terminalId) || !this.store.hasPendingReport(terminalId)) return;
    this.errored.add(terminalId);
    this.onThreadSettled({ terminalId, threadStatus: 'error' });
  }

  /**
   * The StatusService settled edge (and the error edge). Deferred one tick, like the roles
   * listener, so that the turn's outcome and texts are recorded first. Both hooks can fire for
   * one ending in the same tick: the second is dropped, so one ending writes one report. When a
   * settle and an error arrive in the same tick, the first one wins: the settle listener runs
   * first, so the report carries the settle's outcome and text. Never throws.
   */
  onThreadSettled(info: { terminalId: string; threadStatus: string }): void {
    const id = info.terminalId;
    if (this.settling.has(id)) return;
    this.settling.add(id);
    setImmediate(() => {
      this.settling.delete(id);
      try { this.reportThread(id, info.threadStatus); }
      catch (err) { console.warn(`[endless] the report of ${id} failed:`, err); }
    });
  }

  /**
   * Log the thread's report once (the claim and the append share one transaction; a long
   * report is split, never clipped), then, after the commit, hand it to the turn runner: it
   * starts a turn, joins a starting one, or reaches the running one.
   *
   * Ruling (Task 6 fix round 1): every ending (idle/done, error, and recovery) claims ALL of the
   * thread's owed reports and writes ONE report. A question (needs_input) is not an ending: it
   * writes one interim report and claims nothing (ruling I-1, final review). The CLI folds a message it
   * gets mid-turn into the running turn (Task 1 probe c), so one turn can end several jobs; a
   * leftover count would make a user-started turn report, or recovery log a duplicate.
   * Accepted risk: when the CLI runs job 2 as a separate later turn, job 2 gets no report of
   * its own (Chat can still read_thread).
   */
  reportThread(terminalId: string, outcome: string): EndlessMessage[] {
    return this.report(terminalId, outcome);
  }

  private report(terminalId: string, outcome: string): EndlessMessage[] {
    if (this.phase !== 'ready' || this.closed || !this.store.hasPendingReport(terminalId)) return [];
    const t = terminalsDb.getById(this.o.db, terminalId);
    const gone = !t || outcome === 'gone';
    // Ruling (final review I-1): a question is INTERIM. It logs the question once and keeps the
    // owed reports, so the job's real ending (after the answer) still reports its result.
    const interim = !gone && outcome === 'needs_input';
    if (interim && this.store.waitingReported(terminalId)) return [];
    const output = gone ? '' : interim ? this.waitingText(terminalId) : this.o.finalOutput?.(terminalId) ?? '';
    const text = reportText(t?.label || terminalId, gone ? 'gone' : outcome, output);
    const claim = interim ? () => this.store.markWaitingReported(terminalId) : () => this.store.claimAllReports(terminalId);
    const written = this.log({ kind: 'work', text, project: t?.session_id ?? null, ref: terminalId }, { claim });
    if (written.length) {
      this.turns.deliver({ i: written[0].i, kind: 'work', text: written.map((m) => m.text).join(''), project: written[0].project });
    }
    return written;
  }

  /** What a waiting thread asks: its pending question or gated tool, else its last output. */
  private waitingText(terminalId: string): string {
    let asked = '';
    try { asked = pendingQuestionText(this.o.pendingPermission?.(terminalId)); }
    catch (err) { console.warn(`[endless] the pending question of ${terminalId} failed:`, err); }
    return asked || (this.o.finalOutput?.(terminalId) ?? '');
  }

  /**
   * At start: report each thread that ended while no one listened, once (claiming all its
   * owed reports, like any ending). A thread that still runs keeps its reports for its own
   * settle or error edge.
   */
  private recoverReports(): void {
    for (const id of this.store.pendingReports()) {
      try {
        const outcome = recoveryOutcome(terminalsDb.getById(this.o.db, id) ?? null, this.store.waitingReported(id));
        if (outcome) this.report(id, outcome);
      } catch (err) {
        console.warn(`[endless] the recovered report of ${id} failed:`, err);
      }
    }
  }

  /**
   * After the boot kickstart: a thread it skipped because its turn completed reads 'working' (the
   * shutdown race), so recovery left it to a settle edge that never comes. Each such Chat thread
   * that still owes a report reports as idle (final review M-5). Never throws.
   */
  reportCompletedAtBoot(terminalIds: readonly string[]): void {
    for (const id of terminalIds) {
      try {
        const t = terminalsDb.getById(this.o.db, id);
        if (t && threadOrigin(t) === 'endless') this.report(id, 'idle');
      } catch (err) {
        console.warn(`[endless] the boot report of ${id} failed:`, err);
      }
    }
  }

  toWire(m: EndlessMessage): WireMessage {
    return { ...m, media: m.media.map((f) => path.basename(f)), projectName: this.projectName(m.project) };
  }

  log(input: LogInput, opts: LogOptions = {}): EndlessMessage[] {
    if (this.closed) return [];
    const written = appendLogged({ store: this.store, views: this.views, compactor: this.compactor }, input, opts);
    // The messages are committed: a failed broadcast must not hide them from the caller
    // (a report that is logged must also be delivered).
    for (const m of written) {
      try { this.o.broadcaster.broadcast({ type: 'endless:message', message: this.toWire(m) }); }
      catch (err) { console.warn('[endless] a message broadcast failed:', err); }
    }
    return written;
  }

  private emit(e: EndlessEvent): void {
    if (this.closed) return;
    if (e.type === 'endless:turn') {
      this.store.setState('turn_status', e.status);
      this.store.setState('turn_error', e.error ?? '');
    }
    this.o.broadcaster.broadcast(e as unknown as Record<string, unknown>);
  }

  private note(kind: 'turns' | 'compactions', u: Usage): void {
    const list = this.usage[kind];
    list.push(u);
    if (list.length > 200) list.shift();
  }

  send(body: { text: string; project: string | null; images: { media_type: string; data: string }[] }): void {
    if (!body.text.trim() && body.images.length === 0) throw new UserError('a message needs text or an image');
    if (body.project && !sessionsDb.getById(this.o.db, body.project)) throw new UserError(`unknown project: ${body.project}`);
    for (const img of body.images as unknown[]) {
      const ok = !!img && typeof img === 'object' && typeof (img as any).media_type === 'string' && typeof (img as any).data === 'string';
      if (!ok) throw new UserError('each image needs a media_type and base64 data');
      if (!EXT[(img as any).media_type]) throw new UserError(`unsupported image type: ${(img as any).media_type}`);
    }
    const media = body.images.map((img, k) => this.saveImage(img, k));
    this.turns.send({ text: body.text, project: body.project, media });
  }

  private saveImage(img: { media_type: string; data: string }, k: number): string {
    const ext = EXT[img.media_type];
    if (!ext) throw new UserError(`unsupported image type: ${img.media_type}`);
    const data = Buffer.from(String(img.data ?? ''), 'base64');
    if (data.length === 0 || data.length > MAX_IMAGE_BYTES) throw new UserError('an image must be between 1 byte and 10 MB');
    fs.mkdirSync(this.mediaDir, { recursive: true });
    const file = path.join(this.mediaDir, `${this.now()}-${k}-${randomUUID().slice(0, 8)}.${ext}`);
    fs.writeFileSync(file, data);
    return file;
  }

  retry(): boolean { return this.turns.retry(); }
  stopTurn(): boolean { return this.turns.stop(); }
  /** A Claude login just changed: summaries that failed on the old login run again now. */
  retryCompaction(): void { if (!this.closed) this.compactor.retryFailed(); }

  state(): { turn: { status: TurnStatus; error: string | null }; total: number; compactor: { unbuilt: number; merges: number; running: number }; usage: { turns: Usage[]; compactions: Usage[] } } {
    const live = this.turns.status;
    const saved = (this.store.getState('turn_status') ?? 'idle') as TurnStatus;
    const status: TurnStatus = live !== 'idle' ? live : saved === 'failed' || saved === 'interrupted' ? saved : 'idle';
    const error = status === 'failed' ? this.store.getState('turn_error') || null : null;
    return { turn: { status, error }, total: this.store.count(), compactor: this.compactor.stats(), usage: { turns: [...this.usage.turns], compactions: [...this.usage.compactions] } };
  }

  private wirePage(p: Page): { messages: WireMessage[]; hasMore: boolean; hasMoreAfter: boolean } {
    return { messages: p.messages.map((m) => this.toWire(m)), hasMore: p.hasMore, hasMoreAfter: p.hasMoreAfter };
  }

  page(opts: { before?: number; limit: number; project: string | null }) { return this.wirePage(this.store.page(opts)); }
  around(i: number, limit: number, project: string | null) { return this.wirePage(this.store.around(i, limit, project)); }

  search(q: string, project: string | null, limit: number) {
    return this.store.search(q, { project, limit }).map((h) => ({ ...h, projectName: this.projectName(h.project) }));
  }

  viewLines(): { lines: { name: string; l: number; i: number; text: string | null }[]; bytes: number; rendered: string } {
    return { lines: this.views.lines(), bytes: this.views.bytes(), rendered: this.views.rendered() };
  }

  projects(): ProjectStatus[] { return collectProjects(this.o.db, this.store); }

  zoom(id: number, n: number): { text: string; images: ZoomImage[] } {
    try { return zoom(this.store, (pid) => this.projectName(pid), id, n); }
    catch (err) { if (err instanceof RecallError) throw new UserError(err.message); throw err; }
  }

  date(id: number): string {
    try { return dateOf(this.store, id, this.timeZone); }
    catch (err) { if (err instanceof RecallError) throw new UserError(err.message); throw err; }
  }

  threads(): { id: string; project: string; projectName: string; label: string; type: string; status: string; lastActivityAt: string | null }[] {
    return sessionsDb.list(this.o.db).flatMap((s) => terminalsDb.listBySession(this.o.db, s.id).map((t) => ({
      id: t.id, project: s.id, projectName: s.name, label: t.label, type: t.type, status: t.status, lastActivityAt: t.last_activity_at,
    })));
  }

  /** The absolute path of a saved image, or null (names only; no folders). */
  mediaFile(name: string): string | null {
    const base = path.basename(name);
    if (base !== name || base.startsWith('.')) return null;
    const file = path.join(this.mediaDir, base);
    return fs.existsSync(file) ? file : null;
  }
}

/** Daemon boot: a failed start logs and disables only the chat (its routes answer 503). */
export function startEndless(svc: EndlessService, port: number): boolean {
  try {
    svc.start(port);
    return true;
  } catch (err) {
    console.error('[endless] Chat is unavailable: start failed:', err);
    return false;
  }
}
