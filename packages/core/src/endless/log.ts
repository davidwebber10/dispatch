/**
 * The one way a message enters the log: split long text into consecutive messages, append
 * each and save the extended views in one transaction. Only after the transaction commits
 * do the in-memory views change and the compactor hear of the messages, so the view is
 * never ahead of the log; if the transaction throws, memory is unchanged.
 */
import type { EndlessKind, EndlessMessage, EndlessStore } from './store.js';
import type { ViewKeeper, StagedViews } from './view-keeper.js';
import type { Compactor } from './compactor.js';
import { splitLongText } from './text.js';
import { redactKeys } from '../auth/redact-keys.js';

export interface LogInput { kind: EndlessKind; text: string; project?: string | null; ref?: string | null; media?: string[] }
/** `claim` runs first inside the transaction; false logs nothing (a report already logged). */
export interface LogOptions { claim?: () => boolean }

export function appendLogged(t: { store: EndlessStore; views: ViewKeeper; compactor: Compactor }, input: LogInput, opts: LogOptions = {}): EndlessMessage[] {
  const pieces = splitLongText(redactKeys(input.text));
  const done = t.store.transaction((): { written: EndlessMessage[]; staged: StagedViews } | null => {
    if (opts.claim && !opts.claim()) return null;
    const written = pieces.map((text, k) =>
      t.store.append({ kind: input.kind, text, project: input.project ?? null, ref: input.ref ?? null, media: k === 0 ? input.media ?? [] : [] }));
    return { written, staged: t.views.stage(written.map((m) => m.i)) };
  });
  if (!done) return [];
  t.views.commit(done.staged);
  for (const m of done.written) t.compactor.onMessage(m.i);
  return done.written;
}
