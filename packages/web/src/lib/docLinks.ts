// What a link in a thread or a doc does when it is clicked. One answer for every surface and every
// harness: a link to a doc file in a project opens in the doc viewer, a web or mail link opens a new
// tab, and every other target does nothing (it never navigates the app). Pure; the click handler is in Markdown.
import { projectForPath } from './docPaths';
import { parseRoute } from './routes';
import { BASE } from './basePath';

export type LinkAction =
  | { kind: 'doc'; project: string; path: string }
  | { kind: 'web'; href: string }
  /** A thread's own app address, /p/<project>/t/<thread> (2026-11-13): a tap opens that thread. */
  | { kind: 'thread'; projectId: string; threadId: string }
  | { kind: 'none' };

export interface LinkContext {
  /** The project a relative link belongs to (null: none, so a relative doc link does nothing). */
  project: string | null;
  projects: { id: string; folder: string }[];
  /** The repo path of the doc the link is in; a relative link is read from its folder. */
  from?: string;
}

const NONE: LinkAction = { kind: 'none' };
const DOC_LINK = /\.(?:md|markdown|txt)$/i;
const WEB = /^(?:https?:|mailto:)/i;
const FILE_URL = /^file:\/\/(?:localhost)?(\/.*)$/i;
const LINE_SUFFIX = /:\d+(?::\d+)?$/;
const SCHEME = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

function decode(raw: string): string | null {
  try { return decodeURIComponent(raw); } catch { return null; }
}

/** Steps `.` and `..` out of a path. Null when `..` leads above its start. */
function normalize(parts: string[]): string[] | null {
  const out: string[] = [];
  for (const seg of parts) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { if (!out.length) return null; out.pop(); continue; }
    out.push(seg);
  }
  return out;
}

const PRIVATE_V4 = /^(?:10\.|127\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|169\.254\.|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)\d+\.\d+(?:\.\d+)?$/;

/**
 * True when a URL host is a place Dispatch itself is served from: this machine, a LAN or Tailscale
 * address, a `.ts.net` or `.local` name, or the host of this page. An agent writes such a link
 * (`http://localhost:3456/Users/me/app/plan.md`) when it means the file; to the browser it is the app.
 */
function isAppHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h === '::1' || PRIVATE_V4.test(h) || h.endsWith('.ts.net') || h.endsWith('.local')) return true;
  return typeof location !== 'undefined' && !!location.hostname && h === location.hostname.toLowerCase();
}

function isThisApp(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '::1' || h.startsWith('127.') || (typeof location !== 'undefined' && !!location.hostname && h === location.hostname.toLowerCase());
}

/** The file path of a link to the app's own host (`http://localhost:3456/Users/me/plan.md`), else null. */
function appHostPath(h: string): string | null {
  let url: URL;
  try { url = new URL(h); } catch { return null; }
  if (!isAppHost(url.hostname)) return null;
  const path = decode(url.pathname.replace(LINE_SUFFIX, ''));
  return path && DOC_LINK.test(path) ? path : null;
}

/**
 * A link to a thread (owner, 2026-11-13: Chat links the thread it found, and a tap opens it): the
 * thread's app address `/p/<project>/t/<thread>`, as a path or as a URL of this app's own host. A
 * project or agent address, or the same path on another site, is not one.
 */
function threadLink(h: string): LinkAction | null {
  let pathname: string;
  if (/^https?:/i.test(h)) {
    let url: URL;
    try { url = new URL(h); } catch { return null; }
    if (!isAppHost(url.hostname)) return null;
    pathname = url.pathname;
  } else if (h.startsWith('/') && !h.startsWith('//')) {
    pathname = h.split('#')[0].split('?')[0];
  } else return null;
  const route = parseRoute(pathname, BASE);
  if (route.view !== 'workspace' || !route.projectId || !route.threadId) return null;
  return { kind: 'thread', projectId: route.projectId, threadId: route.threadId };
}

export function classifyLink(href: string, ctx: LinkContext): LinkAction {
  const h = href.trim();
  const thread = threadLink(h);
  if (thread) return thread;
  let target = h;
  if (WEB.test(h)) {
    const own = /^https?:/i.test(h) ? appHostPath(h) : null;
    if (own === null) return { kind: 'web', href };
    // Only a path inside a project opens. Anywhere else it is just the app (this machine) so it does
    // nothing; another LAN or Tailscale host is a different site and opens in a new tab as before.
    const act = classifyLink(own.split('/').map(encodeURIComponent).join('/'), { ...ctx, from: undefined });
    return act.kind === 'none' && !isThisApp(new URL(h).hostname) ? { kind: 'web', href } : act;
  }
  const file = FILE_URL.exec(h);
  if (file) target = file[1];
  // A :line suffix is dropped first, so `plan.md:12` is not read as a scheme.
  else if (SCHEME.test(h.replace(LINE_SUFFIX, '')) || h.startsWith('#')) return NONE;
  // Drop a #L12 or #heading, a ?query and a :line or :line:col suffix; what is left is the path.
  const bare = target.split('#')[0].split('?')[0].replace(LINE_SUFFIX, '');
  const path = decode(bare);
  if (!path || !DOC_LINK.test(path) || /[\\\0]/.test(path)) return NONE;
  const abs = path.startsWith('/');
  // A relative link in a doc that was opened by its absolute path stays absolute.
  const absFrom = !abs && !!ctx.from?.startsWith('/');
  const base = abs || !ctx.from ? [] : ctx.from.split('/').slice(0, -1);
  const parts = normalize([...base, ...path.split('/')]);
  if (!parts || !parts.length) return NONE;
  const clean = (abs || absFrom ? '/' : '') + parts.join('/');
  const project = projectForPath(clean, ctx.project, ctx.projects);
  return project ? { kind: 'doc', project, path: clean } : NONE;
}
