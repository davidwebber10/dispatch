import type Database from 'better-sqlite3';

/** Who sent a message that reached an overseer: the human, a card click, another thread, or the daemon. */
export type CoordinatorMessageSource = 'user' | 'canned' | 'coordinator' | 'daemon';

export interface CoordinatorMessage {
  id: number;
  terminalId: string;
  sentAt: string;
  source: CoordinatorMessageSource;
  text: string;
}

interface Row { id: number; terminal_id: string; sent_at: string; source: CoordinatorMessageSource; text: string }

const toMessage = (r: Row): CoordinatorMessage => ({ id: r.id, terminalId: r.terminal_id, sentAt: r.sent_at, source: r.source, text: r.text });

/** A structural content block. Kept local so this storage module never imports the structured manager. */
type Block = { type?: string; text?: string };

/** The logged text of a send: a string as is; for blocks, the text blocks joined by newlines, each image as "[image]". */
export function messageText(content: string | readonly Block[]): string {
  if (typeof content === 'string') return content;
  return content
    .map((b) => (b?.type === 'text' ? String(b.text ?? '') : b?.type === 'image' ? '[image]' : ''))
    .filter((s) => s !== '')
    .join('\n');
}

/** Append one row. Returns its id. */
export function append(
  db: Database.Database,
  input: { terminalId: string; source: CoordinatorMessageSource; text: string; sentAt?: string },
): number {
  const info = db.prepare('INSERT INTO coordinator_messages (terminal_id, sent_at, source, text) VALUES (?, ?, ?, ?)')
    .run(input.terminalId, input.sentAt ?? new Date().toISOString(), input.source, input.text);
  return Number(info.lastInsertRowid);
}

/** Every logged message for one overseer, oldest first. */
export function listForTerminal(db: Database.Database, terminalId: string): CoordinatorMessage[] {
  return (db.prepare('SELECT * FROM coordinator_messages WHERE terminal_id = ? ORDER BY sent_at ASC, id ASC')
    .all(terminalId) as Row[]).map(toMessage);
}

/** The human's own messages to one overseer, oldest first. With `after`, only those sent strictly after it. */
export function listUserMessages(db: Database.Database, terminalId: string, after: string | null): CoordinatorMessage[] {
  const rows = after === null
    ? db.prepare("SELECT * FROM coordinator_messages WHERE terminal_id = ? AND source = 'user' ORDER BY sent_at ASC, id ASC").all(terminalId)
    : db.prepare("SELECT * FROM coordinator_messages WHERE terminal_id = ? AND source = 'user' AND sent_at > ? ORDER BY sent_at ASC, id ASC").all(terminalId, after);
  return (rows as Row[]).map(toMessage);
}
