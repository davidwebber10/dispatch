import { execFile } from 'child_process';

/**
 * True when the peer socket address is loopback — i.e. the browser making this request is
 * running on THIS machine, so the daemon's Finder is the user's Finder.
 *
 * Callers MUST pass `req.socket.remoteAddress`, never `req.ip`: Express derives `req.ip` from
 * `X-Forwarded-For` when `trust proxy` is enabled, so a remote client could simply claim to be
 * 127.0.0.1. The socket peer address is set by the kernel and cannot be forged.
 */
export function isLoopbackAddress(addr: string | undefined): boolean {
  if (!addr) return false;
  // Node reports IPv4 peers on a dual-stack socket as "::ffff:127.0.0.1".
  const a = addr.startsWith('::ffff:') ? addr.slice(7) : addr;
  return a === '::1' || /^127\./.test(a); // 127.0.0.0/8 is the whole loopback range
}

/**
 * Reveal is only meaningful when Finder exists AND the browser is on this machine. On the
 * headless Mac mini, revealing would pop Finder on a screen nobody is looking at.
 */
export function canReveal(addr: string | undefined, platform: string = process.platform): boolean {
  return platform === 'darwin' && isLoopbackAddress(addr);
}

/**
 * Select the given absolute paths in Finder. Passing several paths at once makes Finder open
 * them ALREADY MULTI-SELECTED — which is the whole point: Finder's own Cmd-C pastes into upload
 * fields, something a web page's clipboard can never do for arbitrary files.
 *
 * Argument array, never a shell string: a file named `$(rm -rf ~).png` is just a filename.
 */
export function revealInFinder(absPaths: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('open', ['-R', ...absPaths], { timeout: 3000 }, (err) => (err ? reject(err) : resolve()));
  });
}
