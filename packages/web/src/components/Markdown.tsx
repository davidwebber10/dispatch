import React, { useState } from 'react';
import DOMPurify from 'dompurify';
import { renderMarkdown } from '../lib/markdown';
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

export const Markdown = React.memo(function Markdown({ source }: { source: string }) {
  // Markdown-embedded images render as raw sanitized <img> tags with no React handlers,
  // so on a phone a tap did nothing while every ChatImage opened the lightbox — one
  // delegated click handler on the chokepoint gives every markdown image the same viewer.
  const [lightbox, setLightbox] = useState<{ src: string; alt?: string } | null>(null);
  const onClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const t = e.target as HTMLElement;
    if (t.tagName === 'IMG') {
      const img = t as HTMLImageElement;
      if (img.src) setLightbox({ src: img.src, alt: img.alt || undefined });
    }
  };
  return (
    <>
      <div className="md-view" style={{ minWidth: 0 }} onClick={onClick} dangerouslySetInnerHTML={{ __html: sanitize(renderMarkdown(source)) }} />
      {lightbox && <ImageLightbox src={lightbox.src} alt={lightbox.alt} onClose={() => setLightbox(null)} />}
    </>
  );
});
