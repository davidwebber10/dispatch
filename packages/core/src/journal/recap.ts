// packages/core/src/journal/recap.ts
//
// A short recap of a thread's earlier conversation, written from the message journal, for a thread
// whose Claude conversation is gone (its transcript was cleaned up, or it never got written). The
// recap goes to the NEW conversation as part of its system prompt, so the model has the gist of what
// came before and the person does not have to explain it again. It is a gist, not a replay.

import type { MessageJournal, JournalItem } from './journal.js';

/** The most recent user and assistant messages the recap may name. */
const MAX_TURNS = 12;
/** The most characters of one message. */
const MAX_TURN_CHARS = 500;
/** The most characters of the whole recap. */
const MAX_RECAP_CHARS = 4000;

function textOf(item: JournalItem): string {
  const p = item.payload as { message?: { content?: unknown } } | null;
  const c = p?.message?.content;
  if (typeof c === 'string') return c.trim();
  if (!Array.isArray(c)) return '';
  return c.map((b: any) => (b?.type === 'text' && typeof b.text === 'string' ? b.text : '')).join('').trim();
}

/**
 * The recap, or null when the journal holds no earlier user or assistant text. `skip` is text that is
 * about to be sent again to the new conversation (the message nobody answered): it is left out here.
 */
export function journalRecap(journal: MessageJournal, terminalId: string, skip: readonly string[] = []): string | null {
  let items: JournalItem[];
  try { items = journal.page(terminalId, { limit: 200 }).items; } catch { return null; }
  const pending = new Set(skip.map((t) => t.trim()).filter(Boolean));
  const turns: string[] = [];
  for (const item of items) {
    if (item.kind !== 'user' && item.kind !== 'assistant') continue;
    const t = textOf(item);
    if (!t) continue;
    if (item.kind === 'user' && pending.has(t)) continue;
    const cut = t.length > MAX_TURN_CHARS ? `${t.slice(0, MAX_TURN_CHARS)}...` : t;
    turns.push(`${item.kind === 'user' ? 'User' : 'Assistant'}: ${cut}`);
  }
  if (turns.length === 0) return null;
  let body = turns.slice(-MAX_TURNS).join('\n\n');
  if (body.length > MAX_RECAP_CHARS) body = body.slice(body.length - MAX_RECAP_CHARS);
  return [
    'Dispatch note: this thread had an earlier conversation that could not be loaded, so you are starting fresh.',
    'This is a short recap of its latest messages, taken from Dispatch\'s own record. It is incomplete: treat it as background, and ask if you need more.',
    '',
    body,
  ].join('\n');
}
