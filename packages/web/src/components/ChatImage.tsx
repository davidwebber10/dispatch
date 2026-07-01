import { useEffect, useRef, useState, type TouchEvent } from 'react';
import { Check, Copy, DownloadSimple, X } from '@phosphor-icons/react';

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
  'image/bmp': 'bmp',
};

const MIN_SCALE = 1;
const MAX_SCALE = 4;

// Chrome/Firefox/Safari all accept a live ClipboardItem write, but only in a secure
// context with the constructor present — feature-detect once rather than per click.
const CLIPBOARD_IMAGE_SUPPORTED =
  typeof navigator !== 'undefined' &&
  !!navigator.clipboard &&
  typeof navigator.clipboard.write === 'function' &&
  typeof (globalThis as unknown as { ClipboardItem?: unknown }).ClipboardItem === 'function';

function slugify(input: string): string {
  return input.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}

/**
 * Fetch `src` (data: URI or same-origin byte route) as a Blob, converting to PNG if
 * it isn't already — clipboard paste targets (Slack, Docs, Photoshop, ...) reliably
 * accept PNG but are inconsistent with other formats. The conversion draws through a
 * blob: URL, which is always same-origin to this page, so it never taints the canvas
 * even though the original fetch of `src` could in principle be cross-origin.
 */
async function fetchAsPngBlob(src: string): Promise<Blob> {
  const res = await fetch(src);
  const blob = await res.blob();
  if (blob.type === 'image/png') return blob;
  const objectUrl = URL.createObjectURL(blob);
  try {
    return await new Promise<Blob>((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext('2d');
        if (!ctx) { reject(new Error('no 2d context')); return; }
        ctx.drawImage(img, 0, 0);
        canvas.toBlob((png) => (png ? resolve(png) : reject(new Error('canvas toBlob failed'))), 'image/png');
      };
      img.onerror = () => reject(new Error('image decode failed'));
      img.src = objectUrl;
    });
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

async function downloadImage(src: string, alt: string | undefined) {
  try {
    const res = await fetch(src);
    const blob = await res.blob();
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

export function ChatImage({ src, alt }: { src: string; alt?: string }) {
  const [open, setOpen] = useState(false);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'error'>('idle');
  const [scale, setScale] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const gesture = useRef<Gesture>(IDLE_GESTURE);

  // Reset zoom/pan each time the lightbox closes, so it reopens un-zoomed.
  useEffect(() => {
    if (open) return;
    setScale(1);
    setPan({ x: 0, y: 0 });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  if (!src) return null;

  async function handleCopy() {
    if (!CLIPBOARD_IMAGE_SUPPORTED) return;
    try {
      const blob = await fetchAsPngBlob(src);
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
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
    gesture.current = IDLE_GESTURE;
    if (scale <= 1.02) { setScale(1); setPan({ x: 0, y: 0 }); }
  }

  const copyTitle = !CLIPBOARD_IMAGE_SUPPORTED
    ? 'Copy not supported in this browser'
    : copyState === 'copied' ? 'Copied!' : copyState === 'error' ? 'Copy failed — try again' : 'Copy image';

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
          <div
            onClick={(e) => e.stopPropagation()}
            style={{ position: 'absolute', top: 16, right: 16, zIndex: 1001, display: 'flex', gap: 8 }}
          >
            <button
              onClick={handleCopy}
              disabled={!CLIPBOARD_IMAGE_SUPPORTED}
              title={copyTitle}
              aria-label="Copy image"
              style={toolbarButtonStyle(!CLIPBOARD_IMAGE_SUPPORTED)}
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
            <button onClick={() => setOpen(false)} title="Close" aria-label="Close" style={toolbarButtonStyle(false)}>
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
        </div>
      )}
    </>
  );
}
