/**
 * Endless Chat text rules (spec 2026-10-13, sections 3 and 4). Sizes are UTF-8 bytes; the
 * tool clip and the long-text split count UTF-16 characters but never split a surrogate pair.
 */

/** Tool output is clipped to head + tail, this many characters in all, before it is logged. */
export const TOOL_CLIP_CHARS = 30_000;
/** Any other text longer than this is logged as several consecutive messages. */
export const PIECE_CHARS = 30_000;

export function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/** The longest prefix of `text` that fits in `max` UTF-8 bytes, never splitting a sequence. */
export function cutBytes(text: string, max: number): string {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= max) return text;
  let end = max;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString('utf8');
}

const isLow = (s: string, k: number): boolean => {
  const c = s.charCodeAt(k);
  return c >= 0xdc00 && c <= 0xdfff;
};

/** Move a slice END back so it never ends between the halves of a surrogate pair. */
const safeEnd = (s: string, k: number): number => (k > 0 && k < s.length && isLow(s, k) ? k - 1 : k);
/** Move a slice START forward so it never starts on the low half of a surrogate pair. */
const safeStart = (s: string, k: number): number => (k > 0 && k < s.length && isLow(s, k) ? k + 1 : k);

export function clipToolOutput(text: string, max: number = TOOL_CLIP_CHARS): string {
  if (text.length <= max) return text;
  const marker = (n: number) => `\n…[${n} characters clipped]…\n`;
  const half = Math.floor((max - marker(text.length).length) / 2);
  const headEnd = safeEnd(text, half);
  const tailStart = safeStart(text, text.length - half);
  return text.slice(0, headEnd) + marker(tailStart - headEnd) + text.slice(tailStart);
}

/** Split into pieces of at most `max` characters; prefer a newline in the last fifth of a piece. */
export function splitLongText(text: string, max: number = PIECE_CHARS): string[] {
  if (text.length <= max) return [text];
  const out: string[] = [];
  let at = 0;
  while (text.length - at > max) {
    let end = at + max;
    const nl = text.lastIndexOf('\n', end - 1);
    if (nl >= at + Math.floor(max * 0.8)) end = nl + 1;
    else end = safeEnd(text, end);
    out.push(text.slice(at, end));
    at = end;
  }
  out.push(text.slice(at));
  return out;
}

export function oneLine(text: string): string {
  return text.replace(/\r\n|\n|\r/g, ' ');
}

/** How a message reads to the model: `kind (project): text`. */
export function messageLine(kind: string, text: string, projectName: string | null): string {
  return `${kind}${projectName ? ` (${projectName})` : ''}: ${text}`;
}
