/**
 * Claude Code reports a finished background task by injecting a `role: 'user'` transcript
 * line whose whole body is a `<task-notification>` XML block. It is NOT the human speaking —
 * but unlike the CLI's other injected context (loaded Skills, system reminders) it carries no
 * `isMeta` flag, which is the one thing every parser in this package filters on. So it slips
 * through as a genuine human turn and lands wherever human turns land: the rendered
 * conversation, the thread namer's title input, the message-source attribution scan.
 *
 * Detection is by CONTENT SHAPE rather than the line's `origin.kind: 'task-notification'`
 * field, because that field exists only on the on-disk transcript — it survives neither the
 * live stream-json envelope nor the backfill events cc-sessions.ts rebuilds. One predicate
 * that works on the body alone therefore covers every path.
 *
 * The web-side twin lives in packages/web/src/lib/taskNotification.ts. Duplicated rather
 * than shared because packages/web has no dependency on this package (ConvItem itself is
 * already declared independently in both); the shape is a fixed CLI output format.
 */

const BLOCK = /^\s*<task-notification>([\s\S]*)<\/task-notification>\s*$/;

/**
 * The CLI's own `<summary>` line for an injected task notification, or undefined when
 * `text` is an ordinary turn.
 *
 * Returns the summary (not a bare boolean) so a rendering caller can show the one
 * human-readable field instead of the raw XML. When `<summary>` is absent (older CLI builds
 * wrote only `<status>`) a generic label stands in — the turn is still an injection and must
 * never be treated as human input.
 */
export function taskNotificationSummary(text: string): string | undefined {
  const m = BLOCK.exec(text);
  if (!m) return undefined;
  const s = /<summary>([\s\S]*?)<\/summary>/.exec(m[1]);
  return (s && s[1].trim()) || 'Background task finished';
}

/** Whether `text` is an injected task notification (see taskNotificationSummary). */
export function isTaskNotification(text: string): boolean {
  return BLOCK.test(text);
}

/**
 * Whether a whole transcript `user` entry is an injected task notification — the
 * message-shape wrapper around isTaskNotification, handling both the string and
 * content-block forms Claude Code writes. Also honors the on-disk `origin.kind` marker
 * when present, which is authoritative and cheaper than the regex.
 */
export function isTaskNotificationEntry(o: any): boolean {
  if (o?.origin?.kind === 'task-notification') return true;
  const c = o?.message?.content;
  if (typeof c === 'string') return isTaskNotification(c);
  if (Array.isArray(c)) {
    const texts = c.filter((b: any) => b?.type === 'text' && typeof b.text === 'string');
    return texts.length > 0 && texts.every((b: any) => isTaskNotification(b.text));
  }
  return false;
}

/**
 * Running a slash command (/compact, /clear, a custom command) makes Claude Code write a
 * `role: 'user'` transcript line whose whole body is command bookkeeping — the invocation
 * wrapper (<command-name>/<command-message>/<command-args>/<command-contents>) and/or the
 * captured output (<local-command-stdout>/<local-command-stderr>). Like a task notification
 * it is NOT the human speaking and carries no `isMeta` flag, so it otherwise renders as a
 * user bubble full of raw XML (e.g. `<local-command-stdout>Compacted</local-command-stdout>`).
 *
 * Detection is by CONTENT SHAPE and, like the task-notification match, anchored to the WHOLE
 * message: a turn is an echo only when it is entirely command tags, so a human quoting one of
 * the tags mid-prose keeps its bubble.
 */
const CMD_TAGS = ['command-name', 'command-message', 'command-args', 'command-contents', 'local-command-stdout', 'local-command-stderr'] as const;
const CMD_BLOCK_G = new RegExp(`<(${CMD_TAGS.join('|')})>[\\s\\S]*?</\\1>`, 'g');
const HAS_CMD_TAG = new RegExp(`<(${CMD_TAGS.join('|')})>`);

/** The short label for a slash-command echo (may be `''` → render nothing), or null when
 *  `text` is an ordinary turn. Prefers the command's captured output; falls back to the
 *  invocation name/args. */
export function commandEchoSummary(text: string): string | null {
  if (!HAS_CMD_TAG.test(text)) return null;
  if (text.replace(CMD_BLOCK_G, '').trim() !== '') return null; // real prose alongside → human turn
  const stdout = innerTag(text, 'local-command-stdout');
  const stderr = innerTag(text, 'local-command-stderr');
  const name = innerTag(text, 'command-name');
  const args = innerTag(text, 'command-args');
  return collapseWs(stdout || stderr || [name, args].filter(Boolean).join(' '));
}

/** Whether `text` is a slash-command echo (see commandEchoSummary). */
export function isCommandEcho(text: string): boolean {
  return commandEchoSummary(text) !== null;
}

function innerTag(body: string, name: string): string {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(body);
  return m ? m[1].trim() : '';
}
function collapseWs(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Classify one `user`-role text body for the renderer: an ordinary human turn, an injected
 * event to show as a muted 'notice' (a task-notification summary or a slash-command echo
 * label), or a 'drop' (injected bookkeeping that carries no readable text). One predicate for
 * every parse path, so the live ws fold, the transcript backfill and the REST page agree.
 */
export type UserTextClass = { kind: 'user' } | { kind: 'notice'; text: string } | { kind: 'drop' };
export function classifyUserText(text: string): UserTextClass {
  const summary = taskNotificationSummary(text);
  if (summary) return { kind: 'notice', text: summary };
  const echo = commandEchoSummary(text);
  if (echo !== null) return echo ? { kind: 'notice', text: echo } : { kind: 'drop' };
  return { kind: 'user' };
}

/**
 * Whether a whole `user` entry is injected bookkeeping the resume-anchor scan must skip — a
 * task notification OR a slash-command echo. Neither is a real prompt that a later assistant
 * turn "answers", so anchoring a resume on one would restart from the wrong place.
 */
export function isInjectedUserEntry(o: any): boolean {
  if (isTaskNotificationEntry(o)) return true;
  const c = o?.message?.content;
  if (typeof c === 'string') return isCommandEcho(c);
  if (Array.isArray(c)) {
    const texts = c.filter((b: any) => b?.type === 'text' && typeof b.text === 'string');
    return texts.length > 0 && texts.every((b: any) => isCommandEcho(b.text));
  }
  return false;
}
