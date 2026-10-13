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

export interface LogInput { kind: EndlessKind; text: string; project?: string | null; ref?: string | null; media?: string[] }

export function appendLogged(t: { store: EndlessStore; views: ViewKeeper; compactor: Compactor }, input: LogInput): EndlessMessage[] {
  const pieces = splitLongText(input.text);
  const { written, staged } = t.store.transaction((): { written: EndlessMessage[]; staged: StagedViews } => {
    const written = pieces.map((text, k) =>
      t.store.append({ kind: input.kind, text, project: input.project ?? null, ref: input.ref ?? null, media: k === 0 ? input.media ?? [] : [] }));
    return { written, staged: t.views.stage(written.map((m) => m.i)) };
  });
  t.views.commit(staged);
  for (const m of written) t.compactor.onMessage(m.i);
  return written;
}
