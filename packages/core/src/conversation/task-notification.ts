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
