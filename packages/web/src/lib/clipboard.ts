/**
 * Image → clipboard, shared by the chat lightbox (ChatImage) and the Files pane.
 *
 * Scope note: a web page can put an IMAGE on the clipboard and nothing else. `ClipboardItem`
 * only supports a narrow MIME allowlist (in practice image/png plus text), Chrome throws on
 * more than one ClipboardItem at a time, and `<input type=file>` does not accept paste at all.
 * So there is no browser path to "copy these 4 PDFs and paste them into an upload field" —
 * that is what Reveal-in-Finder exists for.
 */

/**
 * Feature-detected at CALL time, not module load: the test suite (and any SSR pass) evaluates
 * this module before it can stub navigator/ClipboardItem.
 */
export function clipboardImageSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    !!navigator.clipboard &&
    typeof navigator.clipboard.write === 'function' &&
    typeof (globalThis as unknown as { ClipboardItem?: unknown }).ClipboardItem === 'function'
  );
}

/**
 * Fetch `src` (data: URI or same-origin byte route) as a Blob, converting to PNG if it isn't
 * already — paste targets (Slack, Docs, Photoshop, ...) reliably accept PNG and are
 * inconsistent with everything else. The conversion draws through a blob: URL, which is always
 * same-origin to this page, so the canvas is never tainted even if `src` were cross-origin.
 */
export async function fetchAsPngBlob(src: string): Promise<Blob> {
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

/** Put `src` on the system clipboard as a PNG. Rejects if the browser refuses the write. */
export async function copyImageToClipboard(src: string): Promise<void> {
  const blob = await fetchAsPngBlob(src);
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
}

/**
 * Copy plain text. Prefers the async Clipboard API, but falls back to the legacy
 * execCommand path, because `navigator.clipboard` is undefined in an insecure context —
 * and Dispatch's documented remote access (http://<host>.ts.net:3456) is exactly that.
 *
 * Unlike an image, text CAN still reach the clipboard over plain http, so the right move is to
 * make Copy Path work rather than hide it. Throws if both paths fail, so callers can say so.
 */
export async function copyText(text: string): Promise<void> {
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.clipboard?.writeText === 'function') {
      await navigator.clipboard.writeText(text);
      return;
    }
  } catch {
    // Present but refused (permissions policy, not focused, ...) — try the legacy path anyway.
  }

  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  // Off-screen but still focusable/selectable: `display:none` or `hidden` would make select() a no-op.
  ta.style.cssText = 'position:fixed;top:-1000px;left:-1000px;opacity:0;';
  document.body.appendChild(ta);
  try {
    ta.focus();
    ta.select();
    if (!document.execCommand('copy')) throw new Error('the browser refused the copy');
  } finally {
    ta.remove();
  }
}
