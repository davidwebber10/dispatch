// Anthropic-vision-supported image types. Only these become a REAL base64 image block
// the model SEES; anything else (incl. SVG, which the model can't read) falls back to
// the path-reference line so the agent can still Read it from the inbox on disk.
export const MODEL_IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

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
