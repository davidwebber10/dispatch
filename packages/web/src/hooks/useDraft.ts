import { useCallback, useEffect, useState } from 'react';

const PREFIX = 'dispatch:draft:';

/**
 * The drafts of this page, by id: the authoritative value, updated synchronously on every change.
 * Local storage is only best-effort persistence across a reload. When it is unavailable or full,
 * the text the user typed is still the draft, so an append from outside (a click on the pinned
 * decision card) never replaces it with a stale or empty stored copy.
 */
const memory = new Map<string, string>();

function read(id: string): string {
  const held = memory.get(id);
  if (held !== undefined) return held;
  let stored = '';
  try { stored = localStorage.getItem(PREFIX + id) ?? ''; } catch { /* storage unavailable */ }
  memory.set(id, stored);
  return stored;
}

function write(id: string, v: string): void {
  memory.set(id, v);
  try { if (v) localStorage.setItem(PREFIX + id, v); else localStorage.removeItem(PREFIX + id); } catch { /* storage unavailable or full */ }
}

/** Forget the page's drafts, as a reload does; only local storage survives. Tests start each case with it (src/test/setup.ts). */
export function forgetDraftMemory(): void {
  memory.clear();
}

/** Remove a draft from OUTSIDE a mounted useDraft(id) instance — e.g. a
 * store action clearing a specific id's draft as part of a broader reset. */
export function clearStoredDraft(id: string): void {
  write(id, '');
}

/** Fired on window when a draft changes from outside its useDraft; detail is the draft id. */
const DRAFT_CHANGED = 'dispatch:draft-changed';

/**
 * Append text to a draft from OUTSIDE a mounted useDraft(id) — a click on the pinned decision
 * card (pinned card spec 2026-10-08, Unit 8). With text already there it adds ", " and the new
 * text; it never replaces the draft. A mounted useDraft(id) shows the result at once; an unmounted
 * one reads it when it mounts. Returns the new draft.
 */
export function appendToDraft(id: string, text: string): string {
  const base = read(id).replace(/\s+$/, '');
  const next = base ? `${base}, ${text}` : text;
  write(id, next);
  window.dispatchEvent(new CustomEvent(DRAFT_CHANGED, { detail: id }));
  return next;
}

/**
 * An unsent text draft that survives a page reload. The PWA reloads on resume to
 * pick up new deploys (see watchForUpdates in main.tsx), and iOS evicts/reloads
 * backgrounded PWAs — either wipes plain useState, losing whatever the user had
 * typed but not sent. Persisting per-id to localStorage keeps the draft across the
 * reload; it's cleared on send. Returns [value, set, clear].
 */
export function useDraft(id: string): [string, (v: string) => void, () => void] {
  const [value, setValue] = useState<string>(() => read(id));

  // Re-load when the id changes (the component may be reused across threads
  // without remounting), so each thread keeps its own draft.
  useEffect(() => { setValue(read(id)); }, [id]);

  // …and when appendToDraft changed this id's draft from outside.
  useEffect(() => {
    const onChanged = (e: Event) => { if ((e as CustomEvent<string>).detail === id) setValue(read(id)); };
    window.addEventListener(DRAFT_CHANGED, onChanged);
    return () => window.removeEventListener(DRAFT_CHANGED, onChanged);
  }, [id]);

  const set = useCallback((v: string) => {
    write(id, v);
    setValue(v);
  }, [id]);

  const clear = useCallback(() => {
    write(id, '');
    setValue('');
  }, [id]);

  return [value, set, clear];
}
