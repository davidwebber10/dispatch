// The service worker shows a saved copy of the app shell at launch, so the screen never waits on
// the network (public/sw.js). A reload that MUST reach the daemon — a new version is out, or the
// browser has to land on the sign-in page — drops that copy first, or it would just get the
// saved copy back. Mirrors public/sw.js's SHELL_URL and cache names — change both together.
const SHELL_URL = '/';
const SHELL_CACHE_PREFIX = 'dispatch-dispatch-';

/** Delete the saved shell from every shell cache. Never throws. */
export async function dropSavedShell(): Promise<void> {
  try {
    if (typeof caches === 'undefined') return;
    const keys = (await caches.keys()).filter((k) => k.startsWith(SHELL_CACHE_PREFIX));
    await Promise.all(keys.map(async (k) => (await caches.open(k)).delete(SHELL_URL)));
  } catch { /* storage blocked: the reload still goes to the network once the SW refreshes */ }
}

/** Reload from the network: drop the saved shell, then reload. */
export async function reloadFresh(): Promise<void> {
  await dropSavedShell();
  location.reload();
}
