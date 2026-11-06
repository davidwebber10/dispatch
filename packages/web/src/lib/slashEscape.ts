/**
 * The text of a message to send. Trimmed, except that a leading space before a `/` is kept: it is
 * the escape that sends a literal `/model` (or `/path`) as text. Claude, and the daemon's own
 * guard, read a message that starts with `/word` as a command; one that starts with a space is not.
 */
export function textToSend(text: string): string {
  const end = text.trimEnd();
  const start = end.trimStart();
  return start.startsWith('/') && start.length < end.length ? ` ${start}` : end.trim();
}
