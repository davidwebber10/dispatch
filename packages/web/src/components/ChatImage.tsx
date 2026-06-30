import { useState } from 'react';

/**
 * ChatImage — the shared, DUMB image renderer for BOTH chat surfaces: the agent
 * ChatView's image ConvItem and the overseer's StreamMessage. Props are PRIMITIVES
 * ONLY (`src` / `alt`) — deliberately no `ConvItem` / `StreamMessage` coupling — so
 * either surface can feed it whatever it already has without a shared item type.
 *
 * Renders a bounded, lazy-loaded thumbnail that matches the chat's rounded-card style;
 * clicking opens a full-viewport lightbox (overlay click closes). The lightbox avoids
 * `window.open(src)` so it works for data-URI sources too (some browsers block top-level
 * navigation to data: URLs).
 */
export function ChatImage({ src, alt }: { src: string; alt?: string }) {
  const [open, setOpen] = useState(false);
  if (!src) return null;
  return (
    <>
      <img
        src={src}
        alt={alt || ''}
        loading="lazy"
        onClick={() => setOpen(true)}
        title={alt || 'Open image'}
        style={{
          display: 'block',
          maxWidth: '100%',
          maxHeight: 320,
          width: 'auto',
          height: 'auto',
          objectFit: 'contain',
          borderRadius: 10,
          border: '1px solid var(--color-border)',
          background: 'var(--color-elevated)',
          cursor: 'zoom-in',
        }}
      />
      {open && (
        <div
          onClick={() => setOpen(false)}
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 1000,
            background: 'rgba(0,0,0,.82)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 24,
            cursor: 'zoom-out',
          }}
        >
          <img
            src={src}
            alt={alt || ''}
            style={{ maxWidth: '92vw', maxHeight: '92vh', borderRadius: 8, boxShadow: '0 12px 48px -8px rgba(0,0,0,.7)' }}
          />
        </div>
      )}
    </>
  );
}
