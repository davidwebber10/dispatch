import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode, type TouchEvent } from 'react';
import { createPortal } from 'react-dom';
import { Check, Copy, DownloadSimple, X } from '@phosphor-icons/react';
import { clipboardImageSupported, copyImageToClipboard, loadImageBlob } from '../lib/clipboard';
import { isLocalImageSrc, remoteImageHost } from '../lib/remoteImage';

/**
 * ChatImage — the shared, DUMB image renderer for BOTH chat surfaces: the agent
 * ChatView's image ConvItem and the overseer's StreamMessage. Props are PRIMITIVES
 * ONLY (`src` / `alt`) — deliberately no `ConvItem` / `StreamMessage` coupling — so
 * either surface can feed it whatever it already has without a shared item type.
 *
 * Renders a bounded, lazy-loaded thumbnail that matches the chat's rounded-card style;
 * clicking opens a full-viewport lightbox (backdrop click, the X button, or Escape
 * closes it) with Copy/Download actions and touch pinch-to-zoom + pan. The lightbox
 * avoids `window.open(src)` so it works for data-URI sources too (some browsers block
 * top-level navigation to data: URLs).
 */

const MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/avif': 'avif',
  'image/bmp': 'bmp',
};

const MIN_SCALE = 1;
const MAX_SCALE = 4;

function slugify(input: string): string {
  return input.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}

async function downloadImage(src: string, alt: string | undefined) {
  try {
    const blob = await loadImageBlob(src);
    const ext = MIME_EXT[blob.type] ?? 'png';
    const base = (alt && slugify(alt)) || `image-${Date.now()}`;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${base}.${ext}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch {
    // Best-effort fallback (e.g. fetch blocked) — still works for same-origin/data: URIs.
    const a = document.createElement('a');
    a.href = src;
    a.download = '';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }
}

function toolbarButtonStyle(disabled: boolean): React.CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 36,
    height: 36,
    borderRadius: 8,
    background: 'rgba(20,20,22,.78)',
    border: '1px solid var(--color-border)',
    color: 'var(--color-text-primary)',
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.4 : 1,
  };
}

type Gesture = {
  mode: 'pinch' | 'pan' | null;
  startDist: number;
  startScale: number;
  startPan: { x: number; y: number };
  startX: number;
  startY: number;
};

const IDLE_GESTURE: Gesture = { mode: null, startDist: 0, startScale: 1, startPan: { x: 0, y: 0 }, startX: 0, startY: 0 };

function touchDist(touches: React.TouchList): number {
  return Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY);
}

/**
 * The full-viewport image lightbox, extracted from ChatImage so surfaces that render raw
 * <img> tags (markdown bodies — see Markdown.tsx) can open the SAME viewer on tap instead
 * of doing nothing. Copy/Download toolbar, Escape/backdrop close, pinch-to-zoom + pan, and
 * DOUBLE-TAP zoom toggle (1 ↔ 2.5×) — the pinch gesture is easy to miss one-handed.
 */
export function ImageLightbox({ src, alt, onClose }: { src: string; alt?: string; onClose: () => void }) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'error'>('idle');
  const [scale, setScale] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const gesture = useRef<Gesture>(IDLE_GESTURE);
  const lastTap = useRef(0);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  // A modal takes focus on open and gives it back to the opener on close.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    return () => {
      if (opener && opener.isConnected) opener.focus();
      // The opener row can be replaced at turn end: the composer is the next place to type.
      else document.querySelector<HTMLElement>('textarea[aria-label="Message"]')?.focus();
    };
  }, []);

  // Tab stays inside the dialog: from the last control it wraps to the first, and back.
  // It listens on the window, like Escape: a click on the picture moves focus to the body, and a
  // handler on the dialog would never see the next Tab.
  function trapTab(e: KeyboardEvent) {
    if (e.key !== 'Tab') return;
    const items = [...(dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled])') ?? [])];
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (!dialogRef.current?.contains(active)) { e.preventDefault(); first.focus(); }
    else if (e.shiftKey && active === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); }
      else trapTab(e);
    }
    // Capture phase: a lightbox over another layer (the doc viewer) takes Escape first.
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  async function handleCopy() {
    if (!clipboardImageSupported()) return;
    try {
      await copyImageToClipboard(src);
      setCopyState('copied');
    } catch {
      setCopyState('error');
    } finally {
      setTimeout(() => setCopyState('idle'), 1600);
    }
  }

  function onTouchStart(e: TouchEvent<HTMLImageElement>) {
    if (e.touches.length === 2) {
      gesture.current = { mode: 'pinch', startDist: touchDist(e.touches), startScale: scale, startPan: pan, startX: 0, startY: 0 };
    } else if (e.touches.length === 1 && scale > 1) {
      gesture.current = { mode: 'pan', startDist: 0, startScale: scale, startPan: pan, startX: e.touches[0].clientX, startY: e.touches[0].clientY };
    }
  }

  function onTouchMove(e: TouchEvent<HTMLImageElement>) {
    const g = gesture.current;
    if (g.mode === 'pinch' && e.touches.length === 2) {
      const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, g.startScale * (touchDist(e.touches) / g.startDist)));
      setScale(next);
    } else if (g.mode === 'pan' && e.touches.length === 1) {
      setPan({ x: g.startPan.x + (e.touches[0].clientX - g.startX), y: g.startPan.y + (e.touches[0].clientY - g.startY) });
    }
  }

  function onTouchEnd(e: TouchEvent<HTMLImageElement>) {
    if (e.touches.length >= 2) return; // still multi-touch — nothing changes yet
    if (e.touches.length === 1) {
      // one finger lifted mid-pinch — hand off to pan (or idle) without losing position
      const t = e.touches[0];
      gesture.current = scale > 1
        ? { mode: 'pan', startDist: 0, startScale: scale, startPan: pan, startX: t.clientX, startY: t.clientY }
        : IDLE_GESTURE;
      return;
    }
    const wasPanning = gesture.current.mode === 'pan';
    gesture.current = IDLE_GESTURE;
    // Double-tap toggles zoom. Only when the finger wasn't dragging — a pan that ends
    // near a recent tap must not surprise-zoom.
    if (!wasPanning) {
      const now = Date.now();
      if (now - lastTap.current < 300) {
        lastTap.current = 0;
        if (scale > 1) { setScale(1); setPan({ x: 0, y: 0 }); } else { setScale(2.5); }
        return;
      }
      lastTap.current = now;
    }
    if (scale <= 1.02) { setScale(1); setPan({ x: 0, y: 0 }); }
  }

  const copyTitle = !clipboardImageSupported()
    ? 'Copy not supported in this browser'
    : copyState === 'copied' ? 'Copied!' : copyState === 'error' ? 'Copy failed — try again' : 'Copy image';

  // PORTAL to <body>, not an inline overlay: `position: fixed` is trapped by any
  // transformed ancestor (the mobile shell slides screens with CSS transforms), which
  // left the lightbox mounted but CLIPPED INVISIBLE — it only appeared once navigation
  // reset the transform ("doesn't open until I navigate to settings", 2026-08-16).
  return createPortal(
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={alt || 'Image viewer'}
      onClick={onClose}
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
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ position: 'absolute', top: 'max(16px, env(safe-area-inset-top))', right: 16, zIndex: 1001, display: 'flex', gap: 8 }}
      >
        <button
          onClick={handleCopy}
          disabled={!clipboardImageSupported()}
          title={copyTitle}
          aria-label="Copy image"
          style={toolbarButtonStyle(!clipboardImageSupported())}
        >
          {copyState === 'copied'
            ? <Check size={17} weight="bold" color="var(--color-accent)" />
            : <Copy size={17} weight="bold" color={copyState === 'error' ? 'var(--color-status-red)' : undefined} />}
        </button>
        <button
          onClick={() => downloadImage(src, alt)}
          title="Download image"
          aria-label="Download image"
          style={toolbarButtonStyle(false)}
        >
          <DownloadSimple size={17} weight="bold" />
        </button>
        <button ref={closeRef} onClick={onClose} title="Close" aria-label="Close" style={toolbarButtonStyle(false)}>
          <X size={17} weight="bold" />
        </button>
      </div>
      <img
        src={src}
        alt={alt || ''}
        onClick={(e) => e.stopPropagation()}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onTouchCancel={onTouchEnd}
        style={{
          maxWidth: '92vw',
          maxHeight: '92vh',
          borderRadius: 8,
          boxShadow: '0 12px 48px -8px rgba(0,0,0,.7)',
          touchAction: 'none',
          transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})`,
          transition: gesture.current.mode ? 'none' : 'transform 120ms ease-out',
          cursor: scale > 1 ? 'grab' : 'zoom-out',
        }}
      />
    </div>,
    document.body,
  );
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

export function ChatImage({ src, alt, maxHeight = 320 }: { src: string; alt?: string; maxHeight?: number | string }) {
  const [open, setOpen] = useState(false);
  const host = useContext(ViewerContext);
  // A web address is a way to send data out through the reader's browser, so the image is only
  // requested after a click (the same rule as a Markdown image). data:, blob: and this app's own
  // routes load at once.
  const [consented, setConsented] = useState(false);
  if (!src) return null;
  if (!consented && !isLocalImageSrc(src)) {
    const from = remoteImageHost(src);
    return (
      <button
        type="button"
        className="md-remote-image"
        title={src}
        onClick={() => setConsented(true)}
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
          style={{
            display: 'block',
            maxWidth: '100%',
            maxHeight,
            width: 'auto',
            height: 'auto',
            objectFit: 'contain',
            borderRadius: 10,
            border: '1px solid var(--color-border)',
            background: 'var(--color-elevated)',
          }}
        />
      </button>
      {!host && open && <ImageLightbox src={src} alt={alt} onClose={() => setOpen(false)} />}
    </>
  );
}
