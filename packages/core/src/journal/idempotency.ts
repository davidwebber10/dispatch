// packages/core/src/journal/idempotency.ts
//
// The durable keys of the message route (W3-D): the Idempotency-Key of a POST is kept in the
// journal's `idem_key`, so a repeated key is refused after a daemon restart too.
//
// A message that reached a structured thread made a `user` item (the manager's echo): the key goes
// on that item. A request that made no user item (a typed /model, a message to a CLI thread) gets a
// small record of its own, so its key is known as well. The record is a `notice` that no client renders.

import type { CachedResponse, DurableIdempotencyStore } from '../http/idempotency.js';
import { JournalDuplicateKeyError, type MessageJournal } from './journal.js';

export function journalIdempotencyStore(journal: MessageJournal): DurableIdempotencyStore {
  return {
    find(scope, key) {
      const item = journal.findKey(scope, key);
      if (!item) return null;
      if (item.kind === 'user') return { status: 204 }; // the answer of a delivered message
      const kept = (item.payload as { response?: CachedResponse } | null)?.response;
      return kept && typeof kept.status === 'number' ? kept : { status: 204 };
    },
    mark(scope) {
      return journal.lastSeq(scope);
    },
    save(scope, key, r, mark) {
      // The user item of THIS request: the newest one after the mark that has no key. The route
      // delivers and remembers in one synchronous step, so the newest is the request's own.
      if (r.status === 204 && r.body === undefined && typeof mark === 'number') {
        const mine = journal.page(scope, { afterSeq: mark, limit: 500 }).items.filter((i) => i.kind === 'user' && !i.idemKey).pop();
        if (mine && journal.setKey(scope, mine.seq, key)) return;
      }
      try {
        journal.append(scope, { kind: 'notice', idemKey: key, payload: { type: 'journal', subtype: 'idempotency', response: r } });
      } catch (err) {
        if (!(err instanceof JournalDuplicateKeyError)) throw err; // the key is kept already
      }
    },
  };
}
