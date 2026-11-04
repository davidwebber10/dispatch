/**
 * Links the app builds from stored or agent-supplied text. A `javascript:` URL in an iframe or a link runs
 * script on the app's origin. The Content Security Policy blocks it in Chromium; these checks make that
 * independent of the browser, which matters on iPhone Safari.
 *
 * The URL class reads a URL the way a browser does (it strips tabs and newlines, ignores case and leading
 * spaces and control characters), so "java\tscript:" is read as `javascript:`.
 */

function schemeOf(url: string): string | null {
  try { return new URL(url, window.location.href).protocol; } catch { return null; }
}

/** The Browser tab shows a page in an iframe and offers an "Open" link: only http(s) and about:blank are allowed. */
export function isFrameableUrl(url: string): boolean {
  const scheme = schemeOf(url);
  return scheme === 'http:' || scheme === 'https:' || url.trim().toLowerCase() === 'about:blank';
}

/**
 * The image download fallback points a link at the image address. A chat image is often a data: URI, so data:
 * images stay allowed; a script scheme, or a data: URL that is not an image, does not.
 */
export function isSafeDownloadUrl(url: string): boolean {
  const scheme = schemeOf(url);
  if (scheme === null) return false;
  if (scheme === 'http:' || scheme === 'https:' || scheme === 'blob:') return true;
  if (scheme === 'data:') return /^\s*data:image\//i.test(url.replace(/[\t\n\r]/g, ''));
  return false;
}
