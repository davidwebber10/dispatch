// Turning a thread-to-thread MESSAGE into bytes a PTY-backed agent CLI will accept.
//
// A structured (Pretty) thread takes a message over its JSON-RPC/stream-json channel. A PTY
// thread has no such channel — the only way in is to type into the TUI the CLI is drawing, the
// same way `sendFileReference` already does (service.ts). This module owns the one subtle part:
// how to type text that contains NEWLINES without the TUI submitting a half-written message on
// each one.
//
// A bare "\n" inside the payload is a submit in every agent TUI, so a 5-line message would be
// sent as 5 separate partial messages. The fix is BRACKETED PASTE (DECSET 2004): wrapping the
// text in \x1b[200~ … \x1b[201~ tells the TUI "this is one pasted block, not keystrokes", which
// is exactly what happens when a human pastes multi-line text into Claude Code or Codex. A
// single trailing CR then submits the whole thing as one message.
//
// Single-line text deliberately does NOT use bracketed paste: plain "text\r" is the already-
// proven path (sendFileReference ships it today), so the common case keeps byte-for-byte the
// behaviour that is known to work, and the escape sequences only appear when they buy something.

/** Bracketed-paste start/end (DECSET 2004) — how a terminal frames pasted text. */
const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

/** Carriage return: what actually submits the TUI's input box (\n would insert a newline). */
const SUBMIT = '\r';

/**
 * Remove ESC, the other C0 controls, DEL and the C1 controls. Text typed into a PTY is read as
 * keystrokes: an embedded ESC[201~ ends the bracketed paste early and the rest is typed as
 * commands (a slash command, or `!` for Claude's shell mode). Tab is kept; newline is kept
 * unless `keepNewline` is false, which folds it to a space for one-line fields.
 */
export function stripControlChars(text: string, opts: { keepNewline?: boolean } = {}): string {
  const keepNewline = opts.keepNewline !== false;
  const folded = keepNewline ? text : text.replace(/\r\n|[\r\n]/g, ' ');
  return folded.replace(keepNewline ? /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g : /[\x00-\x08\x0a-\x1f\x7f-\x9f]/g, '');
}

/** True when `text` has any character that stripControlChars would remove, newline included. */
export function hasControlChars(text: string): boolean {
  return /[\x00-\x1f\x7f-\x9f]/.test(text);
}

/**
 * The exact byte string to write into a PTY to deliver `text` as ONE submitted message.
 *
 * Normalizes CRLF/CR line endings to \n first: a stray \r *inside* the payload would submit
 * mid-message even when bracketed, which is the very failure this exists to prevent.
 */
export function ptyMessagePayload(text: string): string {
  const normalized = stripControlChars(text.replace(/\r\n/g, '\n').replace(/\r/g, '\n'));
  if (!normalized.includes('\n')) return normalized + SUBMIT;
  return PASTE_START + normalized + PASTE_END + SUBMIT;
}

/** A content block as the structured transport models it — only `text` survives a PTY. */
type Blockish = { type?: string; text?: string };

/**
 * Flatten a message payload to the plain text a PTY can accept. A string passes through; a
 * block array keeps its text blocks and DROPS the rest (an image can't be typed into a
 * terminal), reporting whether anything was dropped so the caller can tell the sender rather
 * than silently delivering half a message.
 */
export function flattenForPty(content: string | Blockish[]): { text: string; droppedNonText: boolean } {
  if (typeof content === 'string') return { text: content.trim(), droppedNonText: false };
  if (!Array.isArray(content)) return { text: '', droppedNonText: false };
  let droppedNonText = false;
  const parts: string[] = [];
  for (const block of content) {
    if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    else if (block) droppedNonText = true;
  }
  return { text: parts.join('\n').trim(), droppedNonText };
}
