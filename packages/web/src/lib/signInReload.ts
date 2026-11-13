import { reloadFresh } from './shellCache';
import { isBoxDown } from './boxRestart';

const KEY = 'dispatch:signin-reload';
const COOLDOWN_MS = 10_000;

/**
 * The daemon answered 401 auth_required: this browser is not signed in (the token was rotated,
 * or the page was opened before the update). Reload once so the page lands on the daemon's
 * sign-in page. The cooldown stops a reload loop if the sign-in page itself cannot be shown.
 */
export function reloadForSignIn(): void {
  // A hosted workspace that is restarting: a page load now would land on the OS launcher. The quiet
  // wait (lib/boxRestart.ts) decides when the page may load again.
  if (isBoxDown()) return;
  try {
    const last = Number(sessionStorage.getItem(KEY));
    if (last && Date.now() - last < COOLDOWN_MS) return;
    sessionStorage.setItem(KEY, String(Date.now()));
  } catch { /* storage blocked: reload anyway */ }
  void reloadFresh();
}
