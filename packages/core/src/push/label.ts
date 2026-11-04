/**
 * A short device name for the push list, from the browser's user agent: "iPhone · Safari", "Mac · Chrome".
 * The user agent itself is not stored. Falls back to "Unknown device".
 */
export function deviceLabelFromUserAgent(ua: unknown): string {
  if (typeof ua !== 'string' || !ua.trim()) return 'Unknown device';
  const device = /iPhone/.test(ua) ? 'iPhone'
    : /iPad/.test(ua) ? 'iPad'
    : /Android/.test(ua) ? 'Android'
    : /Windows/.test(ua) ? 'Windows'
    : /Macintosh|Mac OS X/.test(ua) ? 'Mac'
    : /Linux|X11/.test(ua) ? 'Linux'
    : null;
  const browser = /Edg(e|A|iOS)?\//.test(ua) ? 'Edge'
    : /OPR\/|Opera/.test(ua) ? 'Opera'
    : /Firefox\/|FxiOS\//.test(ua) ? 'Firefox'
    : /CriOS\/|Chrome\//.test(ua) ? 'Chrome'
    : /Safari\//.test(ua) ? 'Safari'
    : null;
  if (device && browser) return `${device} · ${browser}`;
  return device ?? browser ?? 'Unknown device';
}
