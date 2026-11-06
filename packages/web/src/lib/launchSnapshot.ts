// The last project and thread lists, kept on the device so a launch can draw them at once
// (2026-11-05). Without it the app sat on an empty screen for a full round trip to the Mac —
// seconds while the phone's VPN wakes — before the first project showed. The stores start from
// this snapshot and the live lists replace it the moment they arrive; it is never used for
// anything but the first paint.
import type { Session, Terminal } from '../api/types';

const KEY = 'dispatch:launch-snapshot:v1';
/** A snapshot bigger than this is not worth the storage (and the parse on every launch). */
const MAX_CHARS = 400_000;

export interface LaunchSnapshot {
  sessions: Session[];
  byProject: Record<string, Terminal[]>;
}

let cached: LaunchSnapshot | null | undefined;

/** The saved lists, or null. Read once per page load. */
export function readSnapshot(): LaunchSnapshot | null {
  if (cached !== undefined) return cached;
  cached = null;
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const v = JSON.parse(raw);
      if (v && Array.isArray(v.sessions) && v.byProject && typeof v.byProject === 'object') cached = v as LaunchSnapshot;
    }
  } catch { /* storage blocked or bad JSON: no snapshot */ }
  return cached;
}

/** Save the current lists. Skips an empty list (a failed load must not wipe a good snapshot). */
export function writeSnapshot(s: LaunchSnapshot): void {
  if (!s.sessions.length) return;
  try {
    const raw = JSON.stringify(s);
    if (raw.length > MAX_CHARS) return;
    localStorage.setItem(KEY, raw);
  } catch { /* storage full or blocked */ }
}

/** Test hook: forget the once-per-page read. */
export function resetSnapshotCache(): void { cached = undefined; }
