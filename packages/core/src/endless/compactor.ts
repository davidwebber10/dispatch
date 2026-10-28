/**
 * Builds every tree node once (spec 2026-10-13 section 4; the gist section 4). Ready nodes
 * live in queues: a message's node is ready once fewer than 8 lines before it are unbuilt;
 * a merge is ready once both halves are built. Up to 8 run at once. One recovery pass at
 * boot finds what a stopped daemon left; after that the tree is never scanned.
 */
import { neutralizeMarkers, UNTRUSTED_LINE_NOTE } from '../security/untrusted-text.js';
import type { EndlessStore } from './store.js';
import type { ViewKeeper } from './view-keeper.js';
import type { Summarizer } from './summarizer.js';
import { NODE_BYTES, nodeKey, nodeName, childrenOf, siblingOf, parentOf, firstMessage, lastMessage, type NodeRef } from './tree.js';
import { byteLength, cutBytes, messageLine } from './text.js';
import { renderLine } from './view.js';
import { compressTask, mergeTask, tooLongText } from './prompt.js';

export const MAX_CONCURRENT = 8;
export const MAX_TRIES = 5;
export const READY_WINDOW = 8;

export interface CompactorDeps {
  store: EndlessStore;
  views: ViewKeeper;
  summarizer: Summarizer;
  systemPrompt: () => string;
  projectName: (id: string | null) => string | null;
  onBuilt?: (ref: NodeRef) => void;
  onFailed?: (ref: NodeRef, error: string) => void;
}

const clean = (reply: string): string => reply.trim().replace(/^\d+\+\d+\|\s*/, '').trim();

export class Compactor {
  private unbuilt: number[] = [];
  private merges: NodeRef[] = [];
  private readonly queued = new Set<string>();
  private readonly running = new Set<string>();
  /** Failed nodes; tried again at the next message. */
  private readonly cooling = new Set<string>();
  private readonly failures = new Map<string, number>();
  /** Cache-write gate: per compaction-view epoch, one leader runs until its first token. */
  private gate: { epoch: number; leader: string | null; open: boolean } = { epoch: -1, leader: null, open: false };
  private readonly waiters = new Set<() => void>();
  private stopped = false;

  constructor(private readonly d: CompactorDeps) {}

  /** Boot: one pass over the store for nodes a stopped daemon left unbuilt. */
  recover(): void {
    this.unbuilt = this.d.store.unbuiltMessages();
    for (const ref of this.d.store.readyMerges()) this.queueMerge(ref);
    this.pump();
  }

  /** Try the failed nodes again now (the cause is gone, e.g. a Claude login just completed). */
  retryFailed(): void {
    this.cooling.clear();
    this.pump();
  }

  onMessage(i: number): void {
    const last = this.unbuilt[this.unbuilt.length - 1];
    if ((last === undefined || last < i) && !this.d.store.isBuilt(0, i)) this.unbuilt.push(i);
    this.cooling.clear();
    this.pump();
  }

  /** Every message before `n` has its node built, or has failed MAX_TRIES times. */
  settledThrough(n: number): boolean {
    for (const i of this.unbuilt) {
      if (i >= n) return true;
      if ((this.failures.get(nodeKey(0, i)) ?? 0) < MAX_TRIES) return false;
    }
    return true;
  }

  /**
   * Wait until every message before `n` is built, or until each unbuilt one has failed again.
   * A failed node waits in `cooling` for the next message, so the wait first retries those
   * nodes once; a node that fails again ends the wait at once instead of at the timeout
   * (with an expired login, every summary fails within seconds). Resolves true only when
   * everything before `n` is built or given up (settledThrough).
   */
  waitForSettled(n: number, timeoutMs: number): Promise<boolean> {
    if (this.settledThrough(n)) return Promise.resolve(true);
    this.retryFailed();
    if (this.settledThrough(n)) return Promise.resolve(true);
    return new Promise((resolve) => {
      const done = (v: boolean) => { clearTimeout(timer); this.waiters.delete(check); resolve(v); };
      const check = () => {
        if (this.settledThrough(n)) done(true);
        else if (this.nothingLeftToTry(n)) done(false);
      };
      const timer = setTimeout(() => done(false), timeoutMs);
      this.waiters.add(check);
    });
  }

  /** Every unbuilt message before `n` has failed in this round (cooling) or for good: no build is coming. */
  private nothingLeftToTry(n: number): boolean {
    for (const i of this.unbuilt) {
      if (i >= n) break;
      const key = nodeKey(0, i);
      if (this.running.has(key)) return false;
      if (!this.cooling.has(key) && (this.failures.get(key) ?? 0) < MAX_TRIES) return false;
    }
    return true;
  }

  stats(): { unbuilt: number; merges: number; running: number } {
    return { unbuilt: this.unbuilt.length, merges: this.merges.length, running: this.running.size };
  }

  stop(): void { this.stopped = true; }

  private queueMerge(ref: NodeRef): void {
    const key = nodeKey(ref.l, ref.i);
    if (this.queued.has(key) || this.d.store.isBuilt(ref.l, ref.i)) return;
    this.queued.add(key);
    this.merges.push(ref);
  }

  private nextReady(): NodeRef | null {
    let blocking = 0;
    for (const i of this.unbuilt) {
      if (blocking >= READY_WINDOW) break;
      const key = nodeKey(0, i);
      if (!this.running.has(key) && !this.cooling.has(key)) return { l: 0, i };
      if ((this.failures.get(key) ?? 0) < MAX_TRIES) blocking++;
    }
    for (const ref of this.merges) {
      const key = nodeKey(ref.l, ref.i);
      if (!this.running.has(key) && !this.cooling.has(key)) return ref;
    }
    return null;
  }

  private source(ref: NodeRef): string {
    const { store } = this.d;
    if (ref.l === 0) {
      const m = store.get(ref.i)!;
      // A thread's report is data: its line says so (a fixed text, so the cached view stays stable), and it holds no marker of its own.
      return messageLine(m.kind, m.kind === 'work' ? `${UNTRUSTED_LINE_NOTE} ${neutralizeMarkers(m.text)}` : m.text, this.d.projectName(m.project));
    }
    const [a, b] = childrenOf(ref.l, ref.i);
    return `${store.nodeText(a.l, a.i)}\n${store.nodeText(b.l, b.i)}`;
  }

  private pump(): void {
    if (this.stopped) return;
    while (this.running.size < MAX_CONCURRENT) {
      const ref = this.nextReady();
      if (!ref) return;
      const source = this.source(ref);
      const needsModel = byteLength(source) > NODE_BYTES;
      const epoch = this.d.views.epoch;
      if (this.gate.epoch !== epoch) this.gate = { epoch, leader: null, open: false };
      if (needsModel && this.gate.leader !== null && !this.gate.open) return;
      const key = nodeKey(ref.l, ref.i);
      this.running.add(key);
      if (needsModel && this.gate.leader === null) this.gate.leader = key;
      void this.build(ref, key, source, needsModel);
    }
  }

  private async build(ref: NodeRef, key: string, source: string, needsModel: boolean): Promise<void> {
    await Promise.resolve(); // never recurse through pump() synchronously
    try {
      let text = needsModel ? await this.summarize(ref, key, source) : source;
      // A report's line says it is data whether it is the report itself or a summary of it (a fixed text; the cache stays stable).
      if (needsModel && ref.l === 0 && this.d.store.get(ref.i)?.kind === 'work' && !text.startsWith(UNTRUSTED_LINE_NOTE)) text = `${UNTRUSTED_LINE_NOTE} ${neutralizeMarkers(text)}`;
      if (this.stopped) return;
      this.d.store.appendNode(ref.l, ref.i, text);
      this.failures.delete(key);
      if (ref.l === 0) this.unbuilt = this.unbuilt.filter((i) => i !== ref.i);
      else { this.merges = this.merges.filter((m) => m.l !== ref.l || m.i !== ref.i); this.queued.delete(key); }
      const sib = siblingOf(ref.l, ref.i);
      if (this.d.store.isBuilt(sib.l, sib.i)) this.queueMerge(parentOf(ref.l, ref.i));
      this.d.onBuilt?.(ref);
    } catch (err) {
      if (this.stopped) return;
      this.failures.set(key, (this.failures.get(key) ?? 0) + 1);
      this.cooling.add(key);
      this.d.onFailed?.(ref, err instanceof Error ? err.message : String(err));
    } finally {
      this.running.delete(key);
      if (this.gate.leader === key) this.gate.open = true;
      for (const w of [...this.waiters]) w();
      this.pump();
    }
  }

  private async summarize(ref: NodeRef, key: string, source: string): Promise<string> {
    const { store, views } = this.d;
    let task: string;
    if (ref.l === 0) {
      task = compressTask(ref.i, source);
    } else {
      const [a, b] = childrenOf(ref.l, ref.i);
      task = mergeTask(
        nodeName(a.l, a.i), nodeName(b.l, b.i), firstMessage(ref.l, ref.i), lastMessage(ref.l, ref.i),
        renderLine(a.l, a.i, store.nodeText(a.l, a.i)), renderLine(b.l, b.i, store.nodeText(b.l, b.i)),
      );
    }
    const session = this.d.summarizer.open({
      systemPrompt: this.d.systemPrompt(),
      onFirstToken: () => {
        if (this.gate.leader === key && !this.gate.open) { this.gate.open = true; this.pump(); }
      },
    });
    try {
      let best = '';
      let reply = clean(await session.ask(`${views.contextFor(ref)}\n\n${task}`));
      for (let attempt = 1; ; attempt++) {
        // An empty or failed follow-up keeps the best line: a few bytes over is accepted.
        if (!reply) {
          if (best) return best;
          throw new Error('the summary was empty');
        }
        if (!best || byteLength(reply) < byteLength(best)) best = reply;
        if (byteLength(reply) <= NODE_BYTES || attempt >= MAX_TRIES) return best;
        try {
          reply = clean(await session.ask(tooLongText(byteLength(reply), cutBytes(reply, NODE_BYTES))));
        } catch {
          return best;
        }
      }
    } finally {
      session.close();
    }
  }
}
