/** True for an image the page may load at once: data:, blob:, or the app's own origin (relative paths included). */
export function isLocalImageSrc(src: string): boolean {
  try {
    const u = new URL(src, window.location.href);
    return u.protocol === 'data:' || u.protocol === 'blob:' || u.origin === window.location.origin;
  } catch { return false; }
}

/** The host to show on a "Load image" control, or '' when the address has none. */
export function remoteImageHost(src: string): string {
  try { return new URL(src, window.location.href).host; } catch { return ''; }
}
