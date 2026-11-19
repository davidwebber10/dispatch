import type Database from 'better-sqlite3';
import * as store from '../db/memory.js';
import type { TranscriptLocation } from '../conversation/reader.js';
import type { MessageJournal } from '../journal/journal.js';
import { readFileIncrement, readJournalIncrement } from './transcript-source.js';

/**
 * Conversation search, layer 1 (spec 2026-11-17-memory-design.md, slice 1.4). It copies the new words
 * of a thread into memory_turns, from where the thread's cursor stopped. No model is called.
 *
 * When: a thread settles (its turn ended), and once at start for every thread (the catch-up after a
 * stop). One thread at a time, with a yield to the event loop between reads.
 *
 * A thread that is off the record, or whose project is not remembered, is read but not kept: its
 * cursor moves on, so a later switch back on does not bring the words of that time in.
 * Paused or off: nothing is read, and the cursor stays (the words come in when memory goes on).
 */
export interface TurnIndexerDeps {
  db: Database.Database;
  /** The harness file of a Claude Code or Codex thread (sessions/thread-transcripts.ts). */
  locate: (terminalId: string) => TranscriptLocation | null | 'unsupported';
  journal?: MessageJournal;
  /** Memory is on and not paused. */
  active: () => boolean;
  /** Off the record, or its project is not remembered: read, not kept. */
  skip: (terminalId: string) => boolean;
}

const FILE_HARNESSES = new Set(['claude-code', 'codex']);
const yieldToLoop = () => new Promise<void>((r) => setImmediate(r));

export class TurnIndexer {
  private readonly queue = new Set<string>();
  private draining: Promise<void> | null = null;

  constructor(private readonly deps: TurnIndexerDeps) {}

  /** Index this thread soon (after the threads already waiting). */
  schedule(terminalId: string): void {
    this.queue.add(terminalId);
    void this.drain();
  }

  /** Every thread of a harness that has words, once (the start catch-up). Resolves when the queue is empty. */
  catchUp(): Promise<void> {
    const rows = this.deps.db.prepare("SELECT id FROM terminals WHERE type != 'shell' ORDER BY created_at ASC").all() as { id: string }[];
    for (const r of rows) this.queue.add(r.id);
    return this.drain();
  }

  /** Resolves when every scheduled thread is indexed. */
  idle(): Promise<void> { return this.draining ?? Promise.resolve(); }

  private drain(): Promise<void> {
    if (this.draining) return this.draining;
    this.draining = (async () => {
      try {
        while (this.queue.size) {
          const [id] = this.queue;
          this.queue.delete(id);
          try { await this.indexThread(id); } catch (err) { console.warn(`[memory] could not index thread ${id}:`, err); }
          await yieldToLoop();
        }
      } finally {
        this.draining = null;
      }
    })();
    return this.draining;
  }

  /** Read the thread to its end. Returns the number of turns kept. */
  async indexThread(terminalId: string): Promise<number> {
    const { db } = this.deps;
    if (!this.deps.active() || !db.open) return 0;
    const row = db.prepare('SELECT type FROM terminals WHERE id = ?').get(terminalId) as { type: string } | undefined;
    if (!row) return 0;
    let kept = 0;
    if (FILE_HARNESSES.has(row.type)) {
      const loc = this.deps.locate(terminalId);
      if (!loc || loc === 'unsupported') return 0;
      for (;;) {
        const cur = store.getCursor(db, terminalId);
        const inc = await readFileIncrement(loc, cur.source, cur.fileOffset);
        if (!inc || !db.open) return kept;
        if (inc.source === cur.source && inc.offset === cur.fileOffset) return kept;
        kept += store.addTurns(db, terminalId, this.deps.skip(terminalId) ? [] : inc.turns, { source: inc.source, fileOffset: inc.offset });
        if (!inc.more) return kept;
        await yieldToLoop();
      }
    }
    const journal = this.deps.journal;
    if (!journal) return 0;
    for (;;) {
      const cur = store.getCursor(db, terminalId);
      const inc = readJournalIncrement(journal, terminalId, cur.lastSeq);
      if (inc.lastSeq === cur.lastSeq) return kept;
      kept += store.addTurns(db, terminalId, this.deps.skip(terminalId) ? [] : inc.turns, { lastSeq: inc.lastSeq, source: 'journal' });
      if (!inc.more) return kept;
      await yieldToLoop();
    }
  }
}
