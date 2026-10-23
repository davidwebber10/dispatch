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
 * The bytes of an image the page already shows. A data: URI is decoded here, with no request: the
 * Content-Security-Policy keeps connect-src to the app itself, and a fetch of a data: URI counts as a
 * connection. A same-origin byte route is fetched. A remote address is not reachable this way (it needs
 * the other site's CORS and the policy forbids it), so it fails and the caller says the copy failed.
 */
export async function loadImageBlob(src: string): Promise<Blob> {
  // The scheme and the base64 flag are case-insensitive (RFC 2397 and URL syntax).
  if (/^blob:/i.test(src)) return drawToPngBlob(src);
  const m = /^data:([^,]*),(.*)$/is.exec(src);
  if (!m) return (await fetch(src)).blob();
  const meta = m[1].split(';').map((p) => p.trim());
  const type = meta[0] && !/^base64$/i.test(meta[0]) ? meta[0] : 'application/octet-stream';
  const isBase64 = meta.slice(1).some((p) => /^base64$/i.test(p)) || /^base64$/i.test(meta[0]);
  try {
    // Percent-decode to BYTES (not text): a binary payload such as a PNG must survive unchanged.
    const raw = percentDecodeBytes(m[2]);
    if (!isBase64) return new Blob([raw as unknown as BlobPart], { type });
    const bin = atob(String.fromCharCode(...raw).replace(/\s+/g, ''));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type });
  } catch {
    throw new Error('could not decode the image data');
  }
}

/** %XX sequences become their byte; every other character becomes its UTF-8 bytes. A stray % stays as is. */
function percentDecodeBytes(input: string): Uint8Array {
  const enc = new TextEncoder();
  const out: number[] = [];
  for (let i = 0; i < input.length;) {
    if (input[i] === '%' && /^[0-9a-fA-F]{2}$/.test(input.slice(i + 1, i + 3))) {
      out.push(parseInt(input.slice(i + 1, i + 3), 16));
      i += 3;
    } else {
      const cp = input.codePointAt(i)!;
      const ch = String.fromCodePoint(cp);
      out.push(...enc.encode(ch));
      i += ch.length;
    }
  }
  return Uint8Array.from(out);
}

/**
 * Draw an image the page can already show (a blob: URL of this page) onto a canvas and read it back as
 * PNG. No request is made, so the connect-src policy is not involved, and a blob: URL is same-origin so
 * the canvas is never tainted.
 */
function drawToPngBlob(url: string): Promise<Blob> {
  return new Promise<Blob>((resolve, reject) => {
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
    img.src = url;
  });
}

/**
 * Fetch `src` (data: URI or same-origin byte route) as a Blob, converting to PNG if it isn't
 * already — paste targets (Slack, Docs, Photoshop, ...) reliably accept PNG and are
 * inconsistent with everything else. The conversion draws through a blob: URL, which is always
 * same-origin to this page, so the canvas is never tainted even if `src` were cross-origin.
 */
export async function fetchAsPngBlob(src: string): Promise<Blob> {
  const blob = await loadImageBlob(src);
  if (blob.type === 'image/png') return blob;
  const objectUrl = URL.createObjectURL(blob);
  try { return await drawToPngBlob(objectUrl); }
  finally { URL.revokeObjectURL(objectUrl); }
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
