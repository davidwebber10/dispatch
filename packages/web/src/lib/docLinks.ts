// What a link in a thread or a doc does when it is clicked. One answer for every surface and every
// harness: a link to a doc file in a project opens in the doc viewer, a web or mail link opens a new
// tab, and every other target does nothing (it never navigates the app). Pure; the click handler is in Markdown.
import { projectForPath } from './docPaths';

export type LinkAction =
  | { kind: 'doc'; project: string; path: string }
  | { kind: 'web'; href: string }
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

export function classifyLink(href: string, ctx: LinkContext): LinkAction {
  const h = href.trim();
  if (WEB.test(h)) return { kind: 'web', href };
  let target = h;
  const file = FILE_URL.exec(h);
  if (file) target = file[1];
  // A :line suffix is dropped first, so `plan.md:12` is not read as a scheme.
  else if (SCHEME.test(h.replace(LINE_SUFFIX, '')) || h.startsWith('#')) return NONE;
  // Drop a #L12 or #heading, a ?query and a :line or :line:col suffix; what is left is the path.
  const bare = target.split('#')[0].split('?')[0].replace(LINE_SUFFIX, '');
  const path = decode(bare);
  if (!path || !DOC_LINK.test(path) || /[\\\0]/.test(path)) return NONE;
  const abs = path.startsWith('/');
  const base = abs || !ctx.from ? [] : ctx.from.split('/').slice(0, -1);
  const parts = normalize([...base, ...path.split('/')]);
  if (!parts || !parts.length) return NONE;
  const clean = (abs ? '/' : '') + parts.join('/');
  const project = projectForPath(clean, ctx.project, ctx.projects);
  return project ? { kind: 'doc', project, path: clean } : NONE;
}
