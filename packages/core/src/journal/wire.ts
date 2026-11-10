// packages/core/src/journal/wire.ts
//
// The one place that builds the message journal of a daemon and gives it to its users (W3-D).
// createApp and startServer both call it, so the two app builders cannot drift.

import type Database from 'better-sqlite3';
import { setDurableIdempotencyStore } from '../http/idempotency.js';
import { journalIdempotencyStore } from './idempotency.js';
import { MessageJournal } from './journal.js';
import { JournalRecorder } from './recorder.js';
import { createJournalReplay, type JournalReplaySource } from './replay.js';

export interface JournalWiring {
  journal: MessageJournal;
  recorder: JournalRecorder;
  /** For the structured socket: the replay of a thread from the journal. */
  replay: JournalReplaySource;
}

/** A structured manager that can write the journal: the three real managers have the field. */
interface JournalWriter { journal?: JournalRecorder }

/**
 * Make the journal on `db`, give its recorder to each structured manager, and make it the durable
 * store of the Idempotency-Key cache. A test manager with no `journal` field gets the field too; it
 * never attaches a ring, so nothing is written for it.
 */
export function wireJournal(db: Database.Database, managers: Iterable<unknown>): JournalWiring {
  const journal = new MessageJournal(db);
  const recorder = new JournalRecorder(journal);
  for (const manager of managers) {
    if (typeof manager === 'object' && manager !== null) (manager as JournalWriter).journal = recorder;
  }
  setDurableIdempotencyStore(journalIdempotencyStore(journal));
  return { journal, recorder, replay: createJournalReplay(journal, recorder) };
}
