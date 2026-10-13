/**
 * Holds the chat view and the compaction view, saves both after every change, and loads
 * them at start. Never rebuilds them from the log (a rebuilt view differs and kills every
 * cache entry); it only appends lines for messages the saved view does not cover yet.
 *
 * The in-memory views never run ahead of the log: `stage()` computes and saves the next
 * views (inside the caller's SQLite transaction) without touching memory, and `commit()`
 * makes them current only after that transaction has committed.
 */
import type { EndlessStore } from './store.js';
import {
  appendToChatView, appendToCompactionView, resetCompactionView, compactionContext, renderChat, renderChatBlocks,
  lineSize, DEFAULT_LIMITS, type ChatView, type ViewLimits, type NodeText, type LineSize,
} from './view.js';
import { firstMessage, lastMessage, nodeName, type Line, type NodeRef } from './tree.js';

/** The next state of both views, computed and saved but not yet current. */
export interface StagedViews { chat: ChatView; compaction: Line[]; epoch: number; merged: boolean[] }

export class ViewKeeper {
  private chat: ChatView = { lines: [], batching: false };
  private compaction: Line[] = [];
  private epochN = 0;
  private readonly text: NodeText;
  private readonly size: LineSize;

  /**
   * `defer: true` leaves the views empty until `load()`: the service loads them in its
   * guarded start, so a corrupt saved view disables only the chat, not the daemon.
   */
  constructor(private readonly store: EndlessStore, private readonly limits: ViewLimits = DEFAULT_LIMITS, opts: { defer?: boolean } = {}) {
    this.text = (l, i) => store.nodeText(l, i);
    this.size = lineSize(this.text);
    if (!opts.defer) this.load();
  }

  /** Load the saved views and append lines for messages they do not cover yet. */
  load(): void {
    this.chat = this.store.loadChatView() ?? { lines: [], batching: false };
    this.compaction = this.store.loadCompactionView() ?? [];
    const last = this.chat.lines[this.chat.lines.length - 1];
    const covered = last ? lastMessage(last[0], last[1]) + 1 : 0;
    for (let i = covered; i < this.store.count(); i++) this.onMessage(i);
  }

  /** Changes whenever the compaction view is rewritten (not appended): a new cached prefix. */
  get epoch(): number { return this.epochN; }

  /** Message `i` is in the log (committed). Extend both views, save them, and make them current. */
  onMessage(i: number): { merged: boolean } {
    const s = this.stage([i]);
    this.commit(s);
    return { merged: s.merged[0] };
  }

  /**
   * Compute the views after messages `indices` (in order) and save them to the store.
   * Memory is untouched: call this inside the store transaction that appends the messages,
   * then `commit()` after the transaction commits. If it throws, nothing changed.
   */
  stage(indices: readonly number[]): StagedViews {
    let chat = this.chat;
    let compaction = this.compaction;
    let epoch = this.epochN;
    const merged: boolean[] = [];
    for (const i of indices) {
      const T = i + 1;
      const r = appendToChatView(chat, T, this.store.isBuilt, this.size, this.limits);
      chat = r.view;
      if (r.merged) {
        compaction = resetCompactionView(chat.lines, T, this.store.isBuilt, this.size, this.limits);
        epoch++;
      } else {
        const c = appendToCompactionView(compaction, T, this.store.isBuilt, this.size, this.limits);
        compaction = c.lines;
        if (c.merged) epoch++;
      }
      merged.push(r.merged);
    }
    this.store.saveChatView(chat);
    this.store.saveCompactionView(compaction);
    return { chat, compaction, epoch, merged };
  }

  /** Make staged views current. Call only after the writes that staged them have committed. */
  commit(s: StagedViews): void {
    this.chat = s.chat;
    this.compaction = s.compaction;
    this.epochN = s.epoch;
  }

  /**
   * The turn view. With `before`, only the lines that start before message `before`: a message
   * that is already logged (a thread report) is the turn's message, not a view line.
   */
  turnBlocks(before?: number): string[] {
    const lines = before === undefined ? this.chat.lines : this.chat.lines.filter(([l, i]) => firstMessage(l, i) < before);
    return renderChatBlocks(lines, this.text);
  }

  /** The whole `<chat>` view as the model sees it: the turn blocks joined (the same blocks the turn runner sends). */
  rendered(): string { return this.turnBlocks().join(''); }

  contextFor(ref: NodeRef): string { return renderChat(compactionContext(this.compaction, ref, this.store.isBuilt), this.text); }

  lines(): { name: string; l: number; i: number; text: string | null }[] {
    return this.chat.lines.map(([l, i]) => ({ name: nodeName(l, i), l, i, text: this.text(l, i) ?? null }));
  }

  bytes(): number { return this.chat.lines.reduce((s, [l, i]) => s + this.size(l, i), 0); }

  compactionLines(): Line[] { return this.compaction.map(([l, i]) => [l, i]); }
}
