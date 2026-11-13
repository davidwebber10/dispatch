// packages/core/src/tools/image-tools.ts
// The hosted image lists the document and data tools it carries in /etc/dispatch/tools.json (name,
// version, purpose; docker/hosted/tools). A thread's environment note gets ONE line that points to it,
// so an agent reads the list instead of guessing what is installed. No file (a local install): no line.
import fs from 'node:fs';

export const IMAGE_TOOLS_FILE = '/etc/dispatch/tools.json';

export const IMAGE_TOOLS_LINE =
  `Document and data tools are installed (zip/7z, PDF and OCR, pandoc, Python with pandas, openpyxl, python-docx, python-pptx and more): read ${IMAGE_TOOLS_FILE} for the list with versions.`;

/** The pointer line when the image has the list, else ''. Read once: the file is part of the image. */
let cached: { file: string; line: string } | null = null;
export function imageToolsNote(file: string = IMAGE_TOOLS_FILE): string {
  if (cached && cached.file === file) return cached.line;
  let line = '';
  try { if (fs.statSync(file).isFile()) line = file === IMAGE_TOOLS_FILE ? IMAGE_TOOLS_LINE : IMAGE_TOOLS_LINE.replace(IMAGE_TOOLS_FILE, file); } catch { line = ''; }
  cached = { file, line };
  return line;
}
