// packages/core/src/journal/replay.ts
//
// What a viewer of a thread gets from the message journal when it connects (W3-D): one `journal`
// frame with finished items, then the events of what is not finished yet.
//
// The frame and the REST page (routes/journal.ts) are the same `MessageJournal.page`, in the same
// public shape (`publicItem`), so a replay, a page and a resume cannot disagree.
//
// Two cases:
//   - A connect with no cursor (a thread just opened): the newest `limit` items, `reset: true`.
//     The client replaces what it shows.
//   - A reconnect with a cursor (`?after=seq`, the newest sequence the client holds): only the
//     items after it, `reset: false`. The client keeps what it shows and adds them. When the
//     cursor cannot be served (it is ahead of the journal, the rows after it were trimmed, or
//     there are too many), the answer is the first case.

import type { JournalItem, JournalKind, MessageJournal } from './journal.js';
import type { JournalRecorder } from './recorder.js';

/** The most items a resume sends. A client that is further behind gets the newest window again. */
export const RESUME_MAX_ITEMS = 500;
/** The most items of the first window. */
export const REPLAY_MAX_ITEMS = 200;

/** A journal item as a client gets it, on the socket and on the REST route. */
export interface PublicJournalItem {
  seq: number;
  kind: JournalKind;
  at: string;
  /** The Claude-shaped event of the item; the client folds it the way it folds a live event. */
  payload: unknown;
  truncated?: true;
}

export interface JournalFrame {
  type: 'journal';
  /** True: the items are the newest window, and replace what the client shows. False: they come after `after`. */
  reset: boolean;
  /** The cursor that this frame answers, or null. */
  after: number | null;
  items: PublicJournalItem[];
  /** The oldest sequence the journal can give for the thread. */
  firstSeq: number;
  lastSeq: number;
  /** With `reset: true`: older items exist before the window (read them with the REST route). */
  hasMore: boolean;
}

export interface JournalReplay {
  frame: JournalFrame;
  /** The events after the frame: the state no item holds, then the blocks that still stream. */
  tail: unknown[];
}

export interface JournalReplayOptions {
  /** The newest sequence the client holds (`?after=`), when it sent one. */
  after?: number;
  /** The size of the first window. */
  limit?: number;
  /** False when the first window of this thread is not the journal's to give (Codex: REST owns it). A resume is still served. */
  allowReset: boolean;
}

export interface JournalReplaySource {
  /** The replay of a thread from the journal, or null when the journal cannot serve it (the caller then replays the ring). */
  replay(terminalId: string, opts: JournalReplayOptions): JournalReplay | null;
}

export function publicItem(item: JournalItem): PublicJournalItem {
  return { seq: item.seq, kind: item.kind, at: item.at, payload: item.payload, ...(item.truncated ? { truncated: true as const } : {}) };
}

const CONTENT_KINDS: ReadonlySet<JournalKind> = new Set(['user', 'assistant', 'tool', 'result']);

/** The context usage of the newest assistant item of a page, as the frame a client reads it from. */
function usageOf(items: JournalItem[]): unknown {
  for (let i = items.length - 1; i >= 0; i--) {
    const p = items[i].payload as { type?: unknown; parent_tool_use_id?: unknown; context_window?: unknown; message?: { usage?: unknown; model?: unknown } } | null;
    if (!p || p.type !== 'assistant' || p.parent_tool_use_id != null || typeof p.message?.usage !== 'object' || p.message.usage === null) continue;
    return {
      type: 'assistant',
      message: { role: 'assistant', content: [], usage: p.message.usage, ...(typeof p.message.model === 'string' ? { model: p.message.model } : {}) },
      ...(typeof p.context_window === 'number' ? { context_window: p.context_window } : {}),
    };
  }
  return null;
}

export function createJournalReplay(journal: MessageJournal, recorder?: JournalRecorder): JournalReplaySource {
  const tailOf = (terminalId: string, items: JournalItem[], reset: boolean): unknown[] => {
    const state = recorder?.stateEvents(terminalId) ?? [];
    // After a daemon restart the recorder has no usage yet: the journal's newest assistant item has it.
    const hasUsage = state.some((e) => (e as { type?: unknown } | null)?.type === 'assistant');
    const usage = !hasUsage && reset ? usageOf(items) : null;
    return [...(usage ? [usage] : []), ...state, ...(recorder?.openEvents(terminalId) ?? [])];
  };
  return {
    replay(terminalId, opts) {
      const last = journal.lastSeq(terminalId);
      if (last === 0) return null;
      const after = opts.after;
      if (after !== undefined && Number.isInteger(after) && after >= 0 && after <= last) {
        const page = journal.page(terminalId, { afterSeq: after, limit: RESUME_MAX_ITEMS });
        // Served only when the client then holds every item: none trimmed between, none left over.
        const contiguous = page.firstSeq !== 0 && page.firstSeq <= after + 1;
        if (!page.hasMore && (contiguous || after === last)) {
          return {
            frame: { type: 'journal', reset: false, after, items: page.items.map(publicItem), firstSeq: page.firstSeq, lastSeq: page.lastSeq, hasMore: false },
            tail: tailOf(terminalId, page.items, false),
          };
        }
      }
      if (!opts.allowReset) return null;
      const page = journal.page(terminalId, { limit: Math.min(REPLAY_MAX_ITEMS, Math.max(1, Math.floor(opts.limit ?? REPLAY_MAX_ITEMS))) });
      // A journal with nothing a client renders (only marks) is no history: the ring or the transcript has it.
      if (!page.items.some((i) => CONTENT_KINDS.has(i.kind))) return null;
      return {
        frame: { type: 'journal', reset: true, after: null, items: page.items.map(publicItem), firstSeq: page.firstSeq, lastSeq: page.lastSeq, hasMore: page.hasMore },
        tail: tailOf(terminalId, page.items, true),
      };
    },
  };
}
