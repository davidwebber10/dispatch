// "Download thread" (owner, 2026-11-13): a whole thread's conversation as one Markdown file, to paste
// into any other model as context. Pure functions; the route (routes/terminals.ts) reads the pages
// and sends the file.
//
// What goes in: a header with the facts of the thread, then every user message and every assistant
// text, oldest first, with each tool call as one short line. What stays out: thinking, tool output,
// notices, and image data (an image the user sent is written as [image]).
import type { ConvItem } from './transcript.js';
import type { ConvPage, ConvPageOptions } from './reader.js';

export interface ExportMeta {
  label: string;
  project: string | null;
  tool: string;
  model: string | null;
  folder: string | null;
  startedAt: string | null;
  lastActivityAt: string | null;
  exportedAt: string;
}

/** The largest file, in bytes, before the export is cut (a 20 MB conversation is not context for a model anyway). */
export const EXPORT_MAX_BYTES = 20 * 1024 * 1024;
const CUT_NOTE = '[The export was cut here: the conversation is longer than the file limit.]';
const LINE_MAX = 160;

/** The input field that says most about a call, per tool. The first one present wins. */
const SUMMARY_KEYS = ['command', 'file_path', 'notebook_path', 'pattern', 'url', 'query', 'path', 'description', 'prompt', 'id', 'name', 'text'];

const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();
const cut = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const day = (iso: string | null): string | null => (iso && !Number.isNaN(Date.parse(iso)) ? iso.slice(0, 10) : null);

/** One tool call as one line: `→ Bash: npm test`. No output, never more than about 160 characters of input. */
export function toolLine(it: ConvItem): string {
  const name = it.toolName || 'Tool';
  let input: Record<string, unknown> | null = null;
  try { const v = it.toolInput ? JSON.parse(it.toolInput) : null; input = v && typeof v === 'object' && !Array.isArray(v) ? v : null; } catch { input = null; }
  let summary = '';
  if (input) {
    const key = SUMMARY_KEYS.find((k) => typeof input![k] === 'string' && (input![k] as string).trim());
    if (key) summary = input[key] as string;
  }
  if (!summary) summary = it.toolDetail || it.toolFile || '';
  summary = cut(oneLine(summary), LINE_MAX);
  return summary ? `→ ${name}: ${summary}` : `→ ${name}`;
}

/** The file name: the label as ASCII words joined by dashes, then the date. `thread` when nothing is left. */
export function exportFileName(label: string, exportedAt: string): string {
  const slug = label.normalize('NFKD').replace(/[^\x20-\x7e]/g, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '');
  return `${slug || 'thread'}-${day(exportedAt) ?? 'export'}.md`;
}

/** The Markdown file for one thread. `maxBytes` caps the size: past it the file ends with a note. */
export function renderThreadMarkdown(meta: ExportMeta, items: ConvItem[], opts: { maxBytes?: number } = {}): string {
  const maxBytes = opts.maxBytes ?? EXPORT_MAX_BYTES;
  const facts = [
    meta.project ? `- Project: ${meta.project}` : null,
    `- Tool: ${meta.tool}`,
    meta.model ? `- Model: ${meta.model}` : null,
    meta.folder ? `- Folder: ${meta.folder}` : null,
    day(meta.startedAt) ? `- Started: ${meta.startedAt}` : null,
    day(meta.lastActivityAt) ? `- Last activity: ${meta.lastActivityAt}` : null,
    `- Exported at: ${meta.exportedAt}`,
  ].filter(Boolean).join('\n');
  const head = `# ${oneLine(meta.label) || 'Thread'}\n\n${facts}\n\nExported from Dispatch. The full conversation follows, oldest first. Tool calls are listed as one line each, without their output.\n`;

  // The sections: a user message starts a "You" section, the assistant's text and calls of a turn share one.
  const parts: string[] = [];
  let open: 'user' | 'assistant' | null = null;
  const start = (who: 'user' | 'assistant') => {
    if (open === who && who === 'assistant') return;
    parts.push(`\n## ${who === 'user' ? 'You' : 'Assistant'}\n`);
    open = who;
  };
  for (const it of items) {
    if (it.kind === 'user') {
      const text = (it.text ?? '').trim();
      if (!text) continue;
      start('user');
      parts.push(`\n${text}\n`);
      open = 'user';
    } else if (it.kind === 'image' && (it as { imageFromUser?: boolean }).imageFromUser) {
      if (open !== 'user') start('user');
      parts.push('\n[image]\n');
    } else if (it.kind === 'assistant') {
      const text = (it.text ?? '').trim();
      if (!text) continue;
      start('assistant');
      parts.push(`\n${text}\n`);
    } else if (it.kind === 'tool') {
      start('assistant');
      parts.push(`\n${toolLine(it)}\n`);
    }
    // thinking, tool-result, notice and an assistant's image: left out.
  }
  if (parts.length === 0) return `${head}\nNo messages yet.\n`;

  let out = head;
  let size = Buffer.byteLength(out);
  for (const p of parts) {
    const n = Buffer.byteLength(p);
    if (size + n > maxBytes) return `${out}\n${CUT_NOTE}\n`;
    out += p;
    size += n;
  }
  return out;
}

/**
 * Every item of a thread, oldest first: the newest page, then each older page above it, until the
 * reader says there is nothing older. `maxPages` stops a reader that never says so.
 */
export async function collectAllItems(
  page: (opts: ConvPageOptions) => Promise<ConvPage>,
  opts: { pageSize?: number; maxPages?: number } = {},
): Promise<ConvItem[]> {
  const pageSize = opts.pageSize ?? 500;
  const maxPages = opts.maxPages ?? 10_000;
  const chunks: ConvItem[][] = [];
  let p = await page({ limit: pageSize });
  if (p.unsupported) return [];
  chunks.push(p.items);
  for (let n = 1; p.hasMore && p.startLine > 0 && n < maxPages; n++) {
    const before = p.startLine;
    p = await page({ before, limit: pageSize });
    if (p.startLine >= before) break; // no progress: stop rather than loop
    chunks.push(p.items);
  }
  return chunks.reverse().flat();
}
