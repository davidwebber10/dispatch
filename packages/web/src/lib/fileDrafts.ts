/**
 * Unsaved file edits, held per TAB, surviving unmount.
 *
 * WHY THIS EXISTS: TabHost unmounts inactive tabs. React component state therefore CANNOT
 * hold an unsaved edit across a tab switch — before this module, editing a file and then
 * glancing at another tab destroyed the edit: the component unmounted, its `content` state
 * went with it, and on return the tab re-seeded from the clean file cache and refetched from
 * the server right over the top. The user's work vanished silently. With the CSV grid that is
 * devastating: twenty edited cells feel committed, and switching tabs is a natural thing to do.
 *
 * A draft is keyed by terminal id, because a draft belongs to a TAB (not to a path — two tabs
 * on the same file are two independent edits). A draft's EXISTENCE is that tab's dirty state:
 * it is created by the first edit, cleared by a successful save, and dropped by closeTab() when
 * the tab actually goes away (so reopening the file shows what is on disk rather than
 * resurrecting edits the user chose to discard).
 *
 * This module imports nothing — stores and components can both depend on it without a cycle.
 */

const drafts = new Map<string, string>();   // terminalId -> unsaved text

/** The tab's unsaved text, or undefined if it has no unsaved edit. */
export function getDraft(tabId: string): string | undefined {
  return drafts.get(tabId);
}

/** Whether the tab has an unsaved edit — i.e. whether it is dirty. */
export function hasDraft(tabId: string): boolean {
  return drafts.has(tabId);
}

/** Record the tab's unsaved text. Called on every edit, from every edit path. */
export function setDraft(tabId: string, text: string): void {
  drafts.set(tabId, text);
}

/** Drop the tab's unsaved edit — on a successful save, or when the tab is closed/discarded. */
export function clearDraft(tabId: string): void {
  drafts.delete(tabId);
}
