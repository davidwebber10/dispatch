/**
 * Claude Code reports a finished background task by injecting a `role: 'user'` turn whose
 * whole body is a `<task-notification>` XML block. It is NOT the human speaking — but unlike
 * the CLI's other injected context (loaded Skills, system reminders) it carries no `isMeta` /
 * `isSynthetic` flag, only an `origin.kind: 'task-notification'` field on the on-disk
 * transcript line. That field never survives into the live stream-json envelope or the
 * backfill events cc-sessions.ts rebuilds, so metadata alone can't catch every path.
 *
 * Detection is therefore by CONTENT SHAPE, which is identical on all three paths (live ws,
 * transcript backfill, REST page) and needs nothing threaded through the daemon. A human
 * turn that happens to *contain* the tag mid-prose is not one of these — the injected block
 * always occupies the entire message — so the match is anchored to the start and end.
 *
 * The core-side twin lives in packages/core/src/conversation/task-notification.ts. Duplicated
 * rather than shared because packages/web has no dependency on packages/core (ConvItem itself
 * is already declared independently in both); the shape is a fixed CLI output format, so the
 * two are not expected to drift.
 */

const BLOCK = /^\s*<task-notification>([\s\S]*)<\/task-notification>\s*$/;

export interface TaskNotification {
  /** The CLI's own one-line description, e.g. `Background command "…" completed (exit code 0)`. */
  summary: string;
  /** `completed`, `failed`, … — whatever the CLI wrote in <status>. Undefined if absent. */
  status?: string;
}

/**
 * Parse an injected task-notification body, or return null when `text` is an ordinary turn.
 *
 * Returns a notification (rather than a bare boolean) so callers can render the ONE
 * human-readable field — <summary> — instead of the raw XML. When <summary> is missing
 * (older CLI builds wrote only <status>) we fall back to a generic label rather than
 * returning null: the turn is still an injection and must not render as a user bubble.
 */
export function parseTaskNotification(text: string): TaskNotification | null {
  const m = BLOCK.exec(text);
  if (!m) return null;
  const body = m[1];
  const summary = tag(body, 'summary');
  const status = tag(body, 'status');
  return { summary: summary || 'Background task finished', ...(status ? { status } : {}) };
}

function tag(body: string, name: string): string | undefined {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(body);
  return m ? m[1].trim() || undefined : undefined;
}
