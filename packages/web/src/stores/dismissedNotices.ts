import { create } from 'zustand';

export const DISMISSED_NOTICES_KEY = 'dispatch:dismissedNotices';

/** Upper bound on remembered dismissals; the oldest fall off first. A long-lived install
 *  closes a few cards a day, so 500 covers months without the blob growing without end. */
export const DISMISSED_NOTICES_CAP = 500;

/**
 * Status cards (<StatusNotice>: DONE / BLOCKED / NEEDS YOU) the user has closed with the ×,
 * keyed `${scope}:${noticeKey}` — the scope is the thread (or coordinator) the card sat in,
 * the key a content hash of the card's fields (reportStatusKey in chat/reportStatus.ts).
 *
 * Persisted on purpose: closing a card is "I have read this, stop showing it to me", and
 * having every card come back on the next refresh would make the × pointless. Content-keyed
 * rather than id-keyed because the same card reaches the UI with different ids on different
 * paths (a live tool_use id vs REST-paged history with no ids at all), while its text is
 * the same on both.
 *
 * Stored as an ordered list of keys (oldest first) so the cap can drop the oldest; a
 * missing or corrupt blob fails open (nothing dismissed), which matches the UI's default.
 */
function load(): string[] {
  try {
    const v = localStorage.getItem(DISMISSED_NOTICES_KEY);
    if (v == null) return [];
    const parsed = JSON.parse(v) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((k): k is string => typeof k === 'string');
  } catch { return []; }
}
function save(keys: string[]) { try { localStorage.setItem(DISMISSED_NOTICES_KEY, JSON.stringify(keys)); } catch { /* ignore */ } }

/** The map key for one card. Exported so readers can't drift from writers. */
export const dismissKey = (scope: string, noticeKey: string) => `${scope}:${noticeKey}`;

/** The dismissed set a plain render function (renderTimeline / renderStream, no hooks)
 *  needs to skip a closed card's row entirely: the component that calls it subscribes to
 *  `keys` and hands them down with the scope, so the skip is reactive. */
export interface NoticeFilter { scope: string; keys: string[] }

/** Pure form of isDismissed for a NoticeFilter; a null noticeKey is never dismissed. */
export function noticeHidden(filter: NoticeFilter | undefined, noticeKey: string | null): boolean {
  return !!filter && noticeKey != null && filter.keys.includes(dismissKey(filter.scope, noticeKey));
}

interface DismissedNoticesState {
  /** Insertion-ordered dismissed keys, oldest first. */
  keys: string[];
  isDismissed: (scope: string, noticeKey: string) => boolean;
  dismiss: (scope: string, noticeKey: string) => void;
  /** Bring a card back (used by tests and a future "show hidden" control). */
  restore: (scope: string, noticeKey: string) => void;
}

export const useDismissedNotices = create<DismissedNoticesState>((set, get) => ({
  keys: load(),
  isDismissed: (scope, noticeKey) => get().keys.includes(dismissKey(scope, noticeKey)),
  dismiss: (scope, noticeKey) => {
    const k = dismissKey(scope, noticeKey);
    if (get().keys.includes(k)) return;
    const next = [...get().keys, k];
    while (next.length > DISMISSED_NOTICES_CAP) next.shift();
    set({ keys: next });
    save(next);
  },
  restore: (scope, noticeKey) => {
    const k = dismissKey(scope, noticeKey);
    const next = get().keys.filter((x) => x !== k);
    if (next.length === get().keys.length) return;
    set({ keys: next });
    save(next);
  },
}));
