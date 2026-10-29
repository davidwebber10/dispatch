// Anthropic-vision-supported image types. Only these become a REAL base64 image block
// the model SEES; anything else (incl. SVG, which the model can't read) falls back to
// the path-reference line so the agent can still Read it from the inbox on disk.
export const MODEL_IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/**
 * Documents Chat takes besides images (2026-10-28). Mirrors FILE_EXT in core/src/endless/service.ts:
 * the daemon saves them next to the images and names their paths for the model's Read tool.
 * A phone often gives such a file with an empty `type`, so the extension is the fallback.
 */
export const CHAT_DOC_MIME: Record<string, string> = {
  'application/pdf': 'pdf', 'text/plain': 'txt', 'text/markdown': 'md', 'text/csv': 'csv', 'application/json': 'json',
};
const DOC_MIME_BY_EXT: Record<string, string> = { pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', markdown: 'text/markdown', csv: 'text/csv', json: 'application/json' };
export const CHAT_DOC_MAX_BYTES = 20 * 1024 * 1024;
/** The `accept` list for Chat's file input: images and documents, by type and by extension (iOS matches on either). */
export const CHAT_ACCEPT = 'image/jpeg,image/png,image/gif,image/webp,application/pdf,.pdf,text/plain,.txt,text/markdown,.md,text/csv,.csv,application/json,.json';

/** The document media type Chat will send for a picked file, or null when it is not a document Chat takes. */
export function chatDocType(file: { type: string; name: string }): string | null {
  if (file.type && CHAT_DOC_MIME[file.type]) return file.type;
  const ext = /\.([A-Za-z0-9]+)$/.exec(file.name)?.[1]?.toLowerCase();
  // By extension only when the browser gave no type, or a generic one (iOS sends application/octet-stream for some files).
  if (ext && DOC_MIME_BY_EXT[ext] && (!file.type || file.type === 'application/octet-stream')) return DOC_MIME_BY_EXT[ext];
  return null;
}

/** Base64-encode a File's bytes (chunked so a large image can't blow the call stack). */
export async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
