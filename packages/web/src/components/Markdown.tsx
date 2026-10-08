import React, { useMemo, useState } from 'react';
import DOMPurify from 'dompurify';
import { renderMarkdown } from '../lib/markdown';
import { chipifyHtml, type LedgerChips } from '../lib/ledgerRefs';
import { ImageLightbox } from './ChatImage';

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

/**
 * `ledger` (the Control Plane only — pinned card spec 2026-10-08, Unit 9) turns each known ledger
 * number into a chip with its question. The chips are made AFTER the sanitizer, on text nodes
 * only, so the question can never become markup; a click on one is handled here.
 */
export const Markdown = React.memo(function Markdown({ source, ledger }: { source: string; ledger?: LedgerChips }) {
  const html = useMemo(() => {
    const clean = sanitize(renderMarkdown(source));
    return ledger ? chipifyHtml(clean, ledger.index) : clean;
  }, [source, ledger]);
  // Markdown-embedded images render as raw sanitized <img> tags with no React handlers,
  // so on a phone a tap did nothing while every ChatImage opened the lightbox — one
  // delegated click handler on the chokepoint gives every markdown image the same viewer.
  const [lightbox, setLightbox] = useState<{ src: string; alt?: string } | null>(null);
  const chipOf = (t: EventTarget) => (ledger ? (t as HTMLElement).closest?.<HTMLElement>('[data-ledger-chip]') ?? null : null);
  const onClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const t = e.target as HTMLElement;
    const chip = chipOf(t);
    if (chip && ledger) {
      e.stopPropagation();
      ledger.onChip(Number(chip.dataset.ledgerChip), { x: e.clientX, y: e.clientY });
      return;
    }
    if (t.tagName === 'IMG') {
      const img = t as HTMLImageElement;
      if (img.src) setLightbox({ src: img.src, alt: img.alt || undefined });
    }
  };
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const chip = (e.key === 'Enter' || e.key === ' ') && chipOf(e.target);
    if (!chip || !ledger) return;
    e.preventDefault();
    const r = chip.getBoundingClientRect();
    ledger.onChip(Number(chip.dataset.ledgerChip), { x: r.left, y: r.bottom });
  };
  return (
    <>
      <div className="md-view" style={{ minWidth: 0 }} onClick={onClick} onKeyDown={ledger ? onKeyDown : undefined} dangerouslySetInnerHTML={{ __html: html }} />
      {lightbox && <ImageLightbox src={lightbox.src} alt={lightbox.alt} onClose={() => setLightbox(null)} />}
    </>
  );
});
