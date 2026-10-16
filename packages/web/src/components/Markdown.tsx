import React, { useCallback, useMemo, useState } from 'react';
import DOMPurify from 'dompurify';
import { renderMarkdown } from '../lib/markdown';
import { chipifyHtml, type LedgerChips } from '../lib/ledgerRefs';
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
const sanitize = (html: string): string =>
  DOMPurify.sanitize(html, { ADD_TAGS: ['img'], ADD_ATTR: ['src', 'alt'] });

/** Wraps each unlinked image in a focusable opener, so a keyboard user can reach the viewer (see onKeyDown). */
function openableImages(html: string): string {
  if (!html.includes('<img')) return html;
  const box = document.createElement('template');
  box.innerHTML = html;
  for (const img of box.content.querySelectorAll('img')) {
    // A linked image follows its link: no opener inside the anchor (one tab stop, no viewer).
    if (img.closest('a')) continue;
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
 * `ledger` (the Control Plane only — pinned card spec 2026-10-08, Unit 9) turns each known ledger
 * number into a chip with its question. The chips are made AFTER the sanitizer, on text nodes
 * only, so the question can never become markup; a click on one is handled here.
 */
export const Markdown = React.memo(function Markdown({ source, ledger }: { source: string; ledger?: LedgerChips }) {
  const html = useMemo(() => {
    const clean = openableImages(sanitize(renderMarkdown(source)));
    return ledger ? chipifyHtml(clean, ledger.index) : clean;
  }, [source, ledger]);
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
  const onClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const t = e.target as HTMLElement;
    const chip = chipOf(t);
    if (chip && ledger) {
      e.stopPropagation();
      ledger.onChip(Number(chip.dataset.ledgerChip), { x: e.clientX, y: e.clientY });
      return;
    }
    if (t.tagName === 'IMG' && !t.closest('a')) {
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
      <div className="md-view" style={{ minWidth: 0 }} onClick={onClick} onKeyDown={onKeyDown} dangerouslySetInnerHTML={{ __html: html }} />
      {lightbox && <ImageLightbox src={lightbox.src} alt={lightbox.alt} onClose={closeLightbox} />}
    </>
  );
});
