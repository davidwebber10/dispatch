import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import { isLocalImageSrc, remoteImageHost } from '../lib/remoteImage';
import { FileViewer } from './viewer/FileViewer';

/**
 * ChatImage — the shared, DUMB image renderer for BOTH chat surfaces: the agent
 * ChatView's image ConvItem and other surfaces. Props are PRIMITIVES
 * ONLY (`src` / `alt`) — deliberately no `ConvItem` coupling — so
 * either surface can feed it whatever it already has without a shared item type.
 *
 * Renders a bounded, lazy-loaded thumbnail that matches the chat's rounded-card style;
 * clicking opens the full-viewport viewer (backdrop click, the X button, or Escape
 * closes it) with Copy/Share/Download and pinch, wheel and double-tap zoom. The viewer
 * avoids `window.open(src)` so it works for data-URI sources too (some browsers block
 * top-level navigation to data: URLs).
 */

/**
 * The full-viewport image lightbox: the shared FileViewer with one picture, so a chat image
 * gets the same pinch / wheel / double-tap zoom, Copy, Share and Download as a preview's files.
 * Surfaces that render raw <img> tags (markdown bodies, see Markdown.tsx) open it on tap too.
 */
export function ImageLightbox({ src, alt, onClose }: { src: string; alt?: string; onClose: () => void }) {
  return <FileViewer files={[{ src, name: alt || '', mime: 'image/*' }]} onClose={onClose} label={alt || 'Image viewer'} />;
}

type Viewing = { src: string; alt?: string };
const ViewerContext = createContext<((v: Viewing) => void) | null>(null);

/**
 * Holds the open viewer above the rows that open it. A row can be replaced while its viewer is
 * open (a sent image is drawn from the pending send, then from the logged message); a viewer
 * held by the row itself would close with it. Without a host, a ChatImage keeps its own viewer.
 */
export function ImageViewerHost({ children }: { children: ReactNode }) {
  const [viewing, setViewing] = useState<Viewing | null>(null);
  const close = useCallback(() => setViewing(null), []); // stable: the viewer's key listener is not re-bound on every render
  return (
    <ViewerContext.Provider value={setViewing}>
      {children}
      {viewing && <ImageLightbox src={viewing.src} alt={viewing.alt} onClose={close} />}
    </ViewerContext.Provider>
  );
}

/** The opener of the surrounding ImageViewerHost, or null when there is none. */
export function useViewerHost(): ((v: Viewing) => void) | null {
  return useContext(ViewerContext);
}

/**
 * `note`: the text to show when there is no `src` (an image that the daemon's message journal
 * could not keep). An image that does not load (its bytes are gone) shows a note too, in the place
 * of the browser's broken-image mark.
 */
export function ChatImage({ src, alt, maxHeight = 320, note }: { src: string; alt?: string; maxHeight?: number | string; note?: string }) {
  const [open, setOpen] = useState(false);
  // The source that failed to load: a changed src gets its own try.
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const host = useContext(ViewerContext);
  // A web address is a way to send data out through the reader's browser, so the image is only
  // requested after a click (the same rule as a Markdown image). data:, blob: and this app's own
  // routes load at once.
  // Consent names the address that was approved: a changed src needs its own click.
  const [consentedSrc, setConsentedSrc] = useState<string | null>(null);
  const consented = consentedSrc === src;
  if (!src) return note ? <span className="chat-image-note" role="note">{note}</span> : null;
  if (failedSrc === src) return <span className="chat-image-note" role="note">Image not available</span>;
  if (!consented && !isLocalImageSrc(src)) {
    const from = remoteImageHost(src);
    return (
      <button
        type="button"
        className="md-remote-image"
        title={src}
        onClick={() => setConsentedSrc(src)}
      >
        {`Load image${from ? ` from ${from}` : ''}${alt ? `: ${alt}` : ''}`}
      </button>
    );
  }
  return (
    <>
      {/* A real button: it takes keyboard focus, and Enter and Space open the viewer. */}
      <button
        type="button"
        aria-label={alt ? `Open image: ${alt}` : 'Open image'}
        onClick={() => (host ? host({ src, alt }) : setOpen(true))}
        title={alt || 'Open image'}
        style={{ display: 'block', maxWidth: '100%', padding: 0, margin: 0, border: 'none', background: 'none', font: 'inherit', cursor: 'zoom-in' }}
      >
        <img
          src={src}
          alt={alt || ''}
          loading="lazy"
          onError={() => setFailedSrc(src)}
          style={{
            display: 'block',
            maxWidth: '100%',
            maxHeight,
            width: 'auto',
            height: 'auto',
            objectFit: 'contain',
            borderRadius: 'var(--radius-md)',
            border: '1px solid var(--color-border)',
            background: 'var(--color-elevated)',
          }}
        />
      </button>
      {!host && open && <ImageLightbox src={src} alt={alt} onClose={() => setOpen(false)} />}
    </>
  );
}
