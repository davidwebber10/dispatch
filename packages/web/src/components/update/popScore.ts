/**
 * Persistence for the update-rain pop game (see TerminalRain). Two keys:
 *
 * - BEST: the all-time high score {score, date}. Written EAGERLY on every
 *   record-breaking pop, not on unmount — the update flow ends in a hard page
 *   reload (useApplyUpdate), and an unmount-time save would race it and lose.
 * - CELEBRATE: a baton for the post-restart party. Written alongside BEST when
 *   a round beats the score it started against; read-and-cleared by
 *   HighScoreCelebration once the app is back in the normal view. Carries the
 *   beaten previous score for the popup copy, and an `at` timestamp so a flag
 *   that somehow survives (update failed mid-way, tab closed) can't fire a
 *   celebration days later.
 *
 * Everything is try/catch-guarded: localStorage can throw (private mode,
 * storage denied) and a game must never take the update flow down with it.
 */

export interface PopBest { score: number; date: string }
export interface PopCelebration { score: number; prev: number; at: string }

const BEST_KEY = 'dispatch:rain-pop-best';
const CELEBRATE_KEY = 'dispatch:rain-pop-celebrate';
/** A restart round-trip is ~a minute; an hour is generous, a day is stale. */
const CELEBRATION_MAX_AGE_MS = 60 * 60 * 1000;

export function readBest(): PopBest | null {
  try {
    const raw = localStorage.getItem(BEST_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PopBest;
    if (typeof parsed?.score !== 'number' || parsed.score <= 0) return null;
    return { score: parsed.score, date: typeof parsed.date === 'string' ? parsed.date : '' };
  } catch {
    return null;
  }
}

/**
 * Record a record-breaking pop count. `startedAgainst` is the best the ROUND
 * started with (frozen at rain mount) — kept in the celebration payload so the
 * popup can say what was beaten, no matter how many times this round re-broke
 * its own record on the way up.
 */
export function recordBest(count: number, startedAgainst: number): void {
  try {
    const now = new Date().toISOString();
    localStorage.setItem(BEST_KEY, JSON.stringify({ score: count, date: now } satisfies PopBest));
    localStorage.setItem(CELEBRATE_KEY, JSON.stringify({ score: count, prev: startedAgainst, at: now } satisfies PopCelebration));
  } catch {
    /* storage denied — the round still plays, it just isn't remembered */
  }
}

/** One-shot read of the pending celebration: returns it (fresh only) and clears the flag. */
export function readAndClearCelebration(): PopCelebration | null {
  try {
    const raw = localStorage.getItem(CELEBRATE_KEY);
    if (!raw) return null;
    localStorage.removeItem(CELEBRATE_KEY);
    const parsed = JSON.parse(raw) as PopCelebration;
    if (typeof parsed?.score !== 'number' || parsed.score <= 0) return null;
    if (!parsed.at || Date.now() - Date.parse(parsed.at) > CELEBRATION_MAX_AGE_MS) return null;
    return { score: parsed.score, prev: typeof parsed.prev === 'number' ? parsed.prev : 0, at: parsed.at };
  } catch {
    return null;
  }
}

/** "Aug 12", with the year only when it isn't this year's score. */
export function formatBestDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' };
  if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
  return d.toLocaleDateString(undefined, opts);
}
