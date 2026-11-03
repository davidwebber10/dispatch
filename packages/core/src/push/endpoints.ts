/**
 * The Web Push services a browser can hand us as a subscription endpoint. A subscription points the
 * daemon at a URL it will POST every notification to, so an endpoint outside these hosts is refused.
 * Host names match exactly, or as a suffix after a dot, so a look-alike host does not pass.
 */
const EXACT_HOSTS = ['fcm.googleapis.com'];
const SUFFIX_HOSTS = ['push.apple.com', 'push.services.mozilla.com', 'notify.windows.com'];

export function isAllowedPushEndpoint(endpoint: unknown): boolean {
  if (typeof endpoint !== 'string' || !endpoint) return false;
  let url: URL;
  try { url = new URL(endpoint); } catch { return false; }
  if (url.protocol !== 'https:') return false;
  if (url.username || url.password) return false;
  if (url.port && url.port !== '443') return false;
  const host = url.hostname;
  if (EXACT_HOSTS.includes(host)) return true;
  return SUFFIX_HOSTS.some((suffix) => host.endsWith(`.${suffix}`));
}
