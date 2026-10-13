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
import { appendLogged, type LogInput } from './log.js';
import { createSummarizer } from './summarizer-choice.js';
import type { Summarizer, Usage } from './summarizer.js';
import { systemPromptWith } from './prompt.js';
import { buildStatusBlock, collectProjects, type ProjectStatus } from './status-block.js';
import { zoom, dateOf, readImage, RecallError, type ZoomImage } from './recall.js';
import { importOnce } from './import.js';
import { DEFAULT_LIMITS, type ViewLimits } from './view.js';
import { nodeName } from './tree.js';

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

  constructor(private readonly o: EndlessServiceOptions) {
    this.store = new EndlessStore(o.db);
    this.views = new ViewKeeper(this.store, o.limits);
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

  toWire(m: EndlessMessage): WireMessage {
    return { ...m, media: m.media.map((f) => path.basename(f)), projectName: this.projectName(m.project) };
  }

  log(input: LogInput): EndlessMessage[] {
    if (this.closed) return [];
    const written = appendLogged({ store: this.store, views: this.views, compactor: this.compactor }, input);
    for (const m of written) this.o.broadcaster.broadcast({ type: 'endless:message', message: this.toWire(m) });
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

  viewLines(): { lines: { name: string; l: number; i: number; text: string | null }[]; bytes: number } {
    return { lines: this.views.lines(), bytes: this.views.bytes() };
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
