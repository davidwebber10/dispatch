// The OS app list for the app switcher (Dispatch hosted inside Polywood OS).
//
// The browser asks OS directly: GET {osBaseUrl}/api/dispatch/shell, with the person's OS cookie.
// In production OS and the box share an origin, so this is a same-origin call; it is NOT under the
// box's base path and does NOT go through the box. Any failure (not hosted, offline, an old OS, a
// shape we do not know) gives null, and the switcher then lists only the current app. No error is shown.
import { hostContext } from '../../../lib/hostContext';

export interface OsShellApp {
  id: string;
  label: string;
  /** A Phosphor icon name, e.g. "ChartBar" (see OsIcon.tsx). */
  icon: string;
  url: string;
  current?: boolean;
}

export interface OsShell {
  user: { email: string; name: string } | null;
  apps: OsShellApp[];
}

function parseShell(raw: unknown): OsShell | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as { user?: unknown; apps?: unknown };
  if (!Array.isArray(r.apps)) return null;
  const apps: OsShellApp[] = [];
  for (const a of r.apps) {
    if (!a || typeof a !== 'object') continue;
    const x = a as Record<string, unknown>;
    if (typeof x.id !== 'string' || typeof x.label !== 'string' || typeof x.url !== 'string') continue;
    // Only a web address (relative to OS, or http/https) becomes a link.
    if (!/^(https?:\/\/|\/)/i.test(x.url)) continue;
    apps.push({ id: x.id, label: x.label, url: x.url, icon: typeof x.icon === 'string' ? x.icon : '', current: x.current === true });
  }
  const u = r.user as { email?: unknown; name?: unknown } | undefined;
  const user = u && typeof u.email === 'string' ? { email: u.email, name: typeof u.name === 'string' ? u.name : u.email } : null;
  return { user, apps };
}

let cached: Promise<OsShell | null> | null = null;

/** The OS shell (once per page). Null when there is no OS to ask or it did not answer. */
export function loadOsShell(fetchImpl: typeof fetch = (...a) => fetch(...a)): Promise<OsShell | null> {
  if (cached) return cached;
  const base = hostContext().osBaseUrl;
  if (!hostContext().hosted || !base) return (cached = Promise.resolve(null));
  cached = (async () => {
    try {
      const res = await fetchImpl(`${base}/api/dispatch/shell`, { credentials: 'include', headers: { Accept: 'application/json' } });
      if (!res.ok) return null;
      const shell = parseShell(await res.json());
      if (!shell) return null;
      // A relative app URL is relative to OS, not to this page.
      return { ...shell, apps: shell.apps.map((a) => (a.url.startsWith('/') ? { ...a, url: `${base}${a.url}` } : a)) };
    } catch {
      return null;
    }
  })();
  return cached;
}

/** Test seam. */
export function resetOsShellForTest(): void { cached = null; }
export { parseShell };
