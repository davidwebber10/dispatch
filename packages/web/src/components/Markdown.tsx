import React, { useCallback, useMemo, useState } from 'react';
import DOMPurify from 'dompurify';
import { renderMarkdown } from '../lib/markdown';
import { chipifyHtml, type LedgerChips } from '../lib/ledgerRefs';
import { findDocPaths, docName } from '../lib/docPaths';
import type { LinkAction } from '../lib/docLinks';
import { ImageLightbox, useViewerHost } from './ChatImage';

/**
 * Shared markdown surface for the agent chat and the coordinator stream. Routing both
 * through ONE component gives those two surfaces a single `dangerouslySetInnerHTML`
 * chokepoint, styled via `.md-view`.
 *
 * `minWidth:0` lets the host flex/grid track shrink so wide content (code blocks,
 * tables) scrolls inside `.md-view` instead of blowing out the column.
 */
// SANITIZER NOTE: DOMPurify sanitization is now ACTIVE at this chokepoint — every render
// here (agent + coordinator markdown) passes through `sanitize()` below. `<img>` (with
// `src`/`alt`) is explicitly allowed so markdown images + the new image layer survive;
// DOMPurify keeps `data:` URIs for `<img>` by default, so inline base64 images render too.
// This does NOT cover every raw-HTML site: these other renders still call renderMarkdown +
// dangerouslySetInnerHTML directly and must be swept the same way:
//   ConversationView.tsx (L453, L459, L463, L464, L474) and toolviews/WebView.tsx (L16).
// (Code-highlight sinks — ToolCall / QueryView / DiffView via highlightCode — are a separate pass.)
/**
 * `keepFileLinks`: a surface that routes its links (docs.link) keeps `file://` and `plan.md:12` hrefs,
 * which DOMPurify drops. The click handler only opens one that lib/docLinks accepts; every other target does nothing.
 */
/** `plan.md:12`: it reads as a scheme to the sanitizer, but it is a doc name and a line. */
const BARE_DOC_LINE = /^[\w.@%-]+(?:\/[\w.@%-]+)*\.(?:md|markdown|txt):\d+(?::\d+)?$/i;
const sanitize = (html: string, keepFileLinks = false): string => {
  const keep = (_node: Element, data: { attrName: string; attrValue: string; forceKeepAttr?: boolean }) => {
    if (data.attrName === 'href' && (/^\s*file:\/\//i.test(data.attrValue) || BARE_DOC_LINE.test(data.attrValue.trim()))) data.forceKeepAttr = true;
  };
  if (keepFileLinks) DOMPurify.addHook('uponSanitizeAttribute', keep);
  try { return DOMPurify.sanitize(html, { ADD_TAGS: ['img'], ADD_ATTR: ['src', 'alt'] }); }
  finally { if (keepFileLinks) DOMPurify.removeHook('uponSanitizeAttribute', keep); }
};

/**
 * A surface that routes its links keeps no raw destination on a doc link or an unsupported one: a
 * native open (a long press, "Open in new tab") would load it as an app URL. The click handler reads
 * the original from data-md-href. A web link keeps its href.
 */
function neutralizeLinks(html: string, link: (href: string) => LinkAction): string {
  if (!html.includes('href')) return html;
  const box = document.createElement('template');
  box.innerHTML = html;
  for (const a of box.content.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href') ?? '';
    if (link(href).kind === 'web') continue;
    a.setAttribute('data-md-href', href);
    a.setAttribute('href', '#');
  }
  return box.innerHTML;
}

/** Wraps each unlinked image in a focusable opener, so a keyboard user can reach the viewer (see onKeyDown). */
function openableImages(html: string): string {
  if (!html.includes('<img')) return html;
  const box = document.createElement('template');
  box.innerHTML = html;
  for (const img of box.content.querySelectorAll('img')) {
    // A linked image follows its link: no opener inside the anchor (one tab stop, no viewer).
    if (img.closest('a[href]')) continue;
    const opener = document.createElement('span');
    opener.setAttribute('role', 'button');
    opener.setAttribute('tabindex', '0');
    opener.setAttribute('data-md-image', '');
    opener.setAttribute('aria-label', img.alt ? `Open image: ${img.alt}` : 'Open image');
    img.replaceWith(opener);
    opener.append(img);
  }
  return box.innerHTML;
}

/**
 * What a surface needs to draw doc chips: what a click does (the surface picks the project), and
 * optionally which paths are links (a relative path with no project is not one). Keep it stable
 * (useMemo): the chips are redrawn when `accept` changes.
 */
export interface DocChips {
  onOpen: (path: string, branch: string | null) => void;
  accept?: (path: string) => boolean;
  /**
   * What a link in the text does (see lib/docLinks). With it, a click on a link never navigates the
   * app: a doc link calls `onOpen`, a web link opens a new tab, any other link does nothing.
   * Without it, the links keep the browser's own behavior.
   */
  link?: (href: string) => LinkAction;
}

const DOC_EXT = /\.(?:md|markdown|txt)/i;
/** Text inside these stays plain: a link already goes somewhere, a code block is code, a button or a form field is a control. */
const DOC_SKIP = new Set(['A', 'PRE', 'BUTTON', 'SCRIPT', 'STYLE', 'TEXTAREA', 'OPTION']);
/** Text inside a non-HTML element (SVG, MathML) stays plain too: a chip button is HTML only. */
const XHTML = 'http://www.w3.org/1999/xhtml';

/** The doc chip element. Path and name go through the DOM (setAttribute, textContent), never through markup. */
function docChip(doc: Document, path: string, branch: string | null): HTMLElement {
  const el = doc.createElement('button');
  el.setAttribute('type', 'button');
  el.className = 'doc-chip';
  el.setAttribute('data-doc-path', path);
  if (branch) el.setAttribute('data-doc-branch', branch);
  el.setAttribute('title', path);
  el.textContent = docName(path);
  return el;
}

/**
 * Sanitized markdown HTML with each doc path (spec 12.2) turned into a chip. Runs AFTER the
 * sanitizer, on text nodes only (like chipifyHtml). Text inside a link, a code block, a button, a
 * form field, SVG, MathML or a ledger chip is skipped; text inside inline code is included, and an
 * inline code that is one path becomes the chip. HTML with no doc path comes back unchanged.
 */
function docifyHtml(html: string, accept?: (path: string) => boolean): string {
  const forged = html.includes('data-doc-');
  if (!DOC_EXT.test(html) && !forged) return html;
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  const doc = tpl.content.ownerDocument;
  // DOMPurify keeps data-* attributes: a reply's own raw HTML must not pose as a chip.
  if (forged) for (const el of tpl.content.querySelectorAll('[data-doc-path], [data-doc-branch]')) { el.removeAttribute('data-doc-path'); el.removeAttribute('data-doc-branch'); }
  const walker = doc.createTreeWalker(tpl.content, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n as Text);
  let changed = false;
  for (const node of nodes) {
    let skip = false;
    for (let p = node.parentElement; p; p = p.parentElement) if (p.namespaceURI !== XHTML || DOC_SKIP.has(p.tagName) || p.hasAttribute('data-ledger-chip')) { skip = true; break; }
    if (skip) continue;
    const text = node.data;
    const spans = findDocPaths(text).filter((s) => !accept || accept(s.path));
    if (!spans.length) continue;
    changed = true;
    const parent = node.parentElement;
    // An inline code that holds one path and nothing else: the code span becomes the chip (board S6).
    if (parent?.tagName === 'CODE' && parent.childNodes.length === 1 && spans.length === 1 && text.trim() === spans[0].path) {
      parent.replaceWith(docChip(doc, spans[0].path, spans[0].branch));
      continue;
    }
    const frag = doc.createDocumentFragment();
    let last = 0;
    for (const s of spans) {
      if (s.start > last) frag.append(text.slice(last, s.start));
      frag.append(docChip(doc, s.path, s.branch));
      last = s.end;
    }
    if (last < text.length) frag.append(text.slice(last));
    node.replaceWith(frag);
  }
  return changed || forged ? tpl.innerHTML : html;
}

/**
 * `ledger` (the Control Plane only — pinned card spec 2026-10-08, Unit 9) turns each known ledger
 * number into a chip with its question. The chips are made AFTER the sanitizer, on text nodes
 * only, so the question can never become markup; a click on one is handled here. `docs` (Chat)
 * turns each doc path into a doc chip the same way; a click calls `docs.onOpen` and goes no further.
 */
export const Markdown = React.memo(function Markdown({ source, ledger, docs }: { source: string; ledger?: LedgerChips; docs?: DocChips }) {
  const withDocs = !!docs;
  const accept = docs?.accept;
  const linkOf = docs?.link;
  const html = useMemo(() => {
    const safe = sanitize(renderMarkdown(source), !!linkOf);
    const clean = openableImages(linkOf ? neutralizeLinks(safe, linkOf) : safe);
    const chipped = ledger ? chipifyHtml(clean, ledger.index) : clean;
    return withDocs ? docifyHtml(chipped, accept) : chipped;
  }, [source, ledger, withDocs, accept, linkOf]);
  // Markdown-embedded images render as raw sanitized <img> tags with no React handlers,
  // so on a phone a tap did nothing while every ChatImage opened the lightbox — one
  // delegated click handler on the chokepoint gives every markdown image the same viewer.
  // Inside an ImageViewerHost the viewer lives above this row, so it survives the row being replaced
  // at the end of a turn; elsewhere (the Control Plane) this component keeps its own.
  const host = useViewerHost();
  const [lightbox, setLightbox] = useState<{ src: string; alt?: string } | null>(null);
  const closeLightbox = useCallback(() => setLightbox(null), []);
  const openImage = (v: { src: string; alt?: string }) => (host ? host(v) : setLightbox(v));
  const chipOf = (t: EventTarget) => (ledger ? (t as HTMLElement).closest?.<HTMLElement>('[data-ledger-chip]') ?? null : null);
  /** A link click (or a middle click) with docs.link: the link never navigates the app. True when it was a link. */
  const routeLink = (e: React.MouseEvent<HTMLDivElement>): boolean => {
    const a = docs?.link ? (e.target as HTMLElement).closest?.('a[href]') : null;
    if (!a || !docs?.link || !e.currentTarget.contains(a)) return false;
    e.preventDefault();
    e.stopPropagation();
    const href = a.getAttribute('data-md-href') ?? a.getAttribute('href') ?? '';
    const act = docs.link(href);
    if (act.kind === 'doc') docs.onOpen(act.path, null);
    else if (act.kind === 'web') window.open(href, '_blank', 'noopener,noreferrer');
    return true;
  };
  const onAuxClick = (e: React.MouseEvent<HTMLDivElement>) => { if (e.button === 1) routeLink(e); };
  const onClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const t = e.target as HTMLElement;
    if (routeLink(e)) return;
    const doc = docs ? (t.closest?.('[data-doc-path]') as HTMLElement | null) : null;
    if (doc && docs) { e.stopPropagation(); docs.onOpen(doc.dataset.docPath!, doc.dataset.docBranch || null); return; }
    const chip = chipOf(t);
    if (chip && ledger) {
      e.stopPropagation();
      ledger.onChip(Number(chip.dataset.ledgerChip), { x: e.clientX, y: e.clientY });
      return;
    }
    if (t.tagName === 'IMG' && !t.closest('a[href]')) {
      const img = t as HTMLImageElement;
      if (img.src) openImage({ src: img.src, alt: img.alt || undefined });
    }
  };
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const opener = (e.target as HTMLElement).closest?.<HTMLElement>('[data-md-image]');
    const img = opener?.querySelector('img');
    if (opener && img?.src) {
      e.preventDefault();
      openImage({ src: img.src, alt: img.alt || undefined });
      return;
    }
    const chip = chipOf(e.target);
    if (!chip || !ledger) return;
    e.preventDefault();
    const r = chip.getBoundingClientRect();
    ledger.onChip(Number(chip.dataset.ledgerChip), { x: r.left, y: r.bottom });
  };
  return (
    <>
      <div className="md-view" style={{ minWidth: 0 }} onClick={onClick} onAuxClick={onAuxClick} onKeyDown={onKeyDown} dangerouslySetInnerHTML={{ __html: html }} />
      {lightbox && <ImageLightbox src={lightbox.src} alt={lightbox.alt} onClose={closeLightbox} />}
    </>
  );
});
