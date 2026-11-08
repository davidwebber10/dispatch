// The person's own words (coach fix T2): one test the signals and the reviews share. A prompt is
// the person's only when the daemon tagged it 'user' and it is not text the harness or the
// daemon injected (a task notification, a command echo, a system reminder, the compaction
// summary) or a message from another thread or project (a sender line, a wrapped thread message).
// The daemon's file-attach lines ("Use this file as context: ...") are cut first.

const INJECTED = [
  /^<task-notification>/,
  /^<local-command-stdout>/,
  /^<system-reminder>/,
  /^This session is being continued from a previous conversation/,
  /^\[From the overseer of project/,
  /^\[From thread "/,
  /^A message from the thread \[threadId /,
];
const NOT_OWNER = 'This is not a message from the owner.]';
const FILE_LINE_RE = /^Use this file as context: .*$/gm;

/** The person's words in a prompt (file-attach lines cut), or null when they are not the person's. */
export function personText(text, source) {
  if (source !== 'user' || typeof text !== 'string') return null;
  const t = text.replace(FILE_LINE_RE, '').trim();
  if (!t) return null;
  if (INJECTED.some((re) => re.test(t))) return null;
  if (t.includes(NOT_OWNER)) return null;
  return t;
}

/** True when the person wrote this text. */
export function isPersonText(text, source) {
  return personText(text, source) !== null;
}

/** True when a text is a message from another thread or project (a sender line or a wrapped thread message). */
export function isPeerText(text) {
  const t = typeof text === 'string' ? text.trim() : '';
  return /^(\[From the overseer of project|\[From thread "|A message from the thread \[threadId )/.test(t) || t.includes(NOT_OWNER);
}
