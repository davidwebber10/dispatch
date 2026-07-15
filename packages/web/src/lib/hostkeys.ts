// Modifier-key conventions follow the BROWSER's OS, not the daemon's — a Mac user
// browsing a WSL/Linux daemon still expects ⌘, and a Windows/Linux user browsing a
// Mac daemon expects Ctrl. Every "primary modifier" hint and accelerator in the web
// client should route through here instead of hardcoding ⌘/metaKey.

/** True when the browser's platform string looks like a Mac (or iOS, which reports
 *  itself as an "iPhone"/"iPad" platform but never fires metaKey — harmless either way). */
export function isMacLike(plat: string = navigator.platform): boolean {
  return /Mac|iPhone|iPad|iPod/.test(plat);
}

/** The "primary" accelerator modifier for this browser: metaKey (⌘) on a Mac,
 *  ctrlKey elsewhere. Use this instead of checking `e.metaKey` directly. */
export function primaryMod(e: { metaKey: boolean; ctrlKey: boolean }, plat?: string): boolean {
  return isMacLike(plat) ? e.metaKey : e.ctrlKey;
}

/** Render a keyboard hint for the primary modifier + key, e.g. modLabel('N') →
 *  "⌘N" on a Mac, "Ctrl+N" elsewhere. */
export function modLabel(key: string, plat?: string): string {
  return isMacLike(plat) ? `⌘${key}` : `Ctrl+${key}`;
}
