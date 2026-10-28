/**
 * What the memory tools return (spec 2026-10-13 section 6; the gist section 6):
 * zoom(id, n) opens line id+n into the two lines under it; zoom(id, 1) is the message
 * whole, with its images; date(id) is the message's date and time.
 */
import { untrustedBlock } from '../security/untrusted-text.js';
import fs from 'node:fs';
import path from 'node:path';
import type { EndlessStore } from './store.js';
import { fromName, childrenOf } from './tree.js';
import { renderLine } from './view.js';
import { messageLine } from './text.js';

export class RecallError extends Error {}

export interface ZoomImage { mimeType: string; data: string }

const MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };

export function readImage(file: string): ZoomImage | null {
  const mimeType = MIME[path.extname(file).toLowerCase()];
  if (!mimeType) return null;
  try { return { mimeType, data: fs.readFileSync(file).toString('base64') }; } catch { return null; }
}

export function zoom(store: EndlessStore, projectName: (id: string | null) => string | null, id: number, n: number): { text: string; images: ZoomImage[] } {
  const ref = fromName(id, n);
  if (!ref) throw new RecallError('n must be a power of 2 and id a multiple of n');
  const T = store.count();
  if (id + n > T) throw new RecallError(`messages ${id} to ${id + n - 1} are not all in the chat yet (it has ${T})`);
  if (n === 1) {
    const m = store.get(id)!;
    const images = m.media.map(readImage).filter((x): x is ZoomImage => x !== null);
    // A thread's report is data (it may carry text from a hostile page): zoom shows it inside the marked block.
    const body = m.kind === 'work' ? untrustedBlock('a thread report', m.text) : m.text;
    return { text: `#${id} ${messageLine(m.kind, body, projectName(m.project))}`, images };
  }
  const [a, b] = childrenOf(ref.l, ref.i);
  return { text: [a, b].map((c) => renderLine(c.l, c.i, store.nodeText(c.l, c.i))).join('\n'), images: [] };
}

export function formatWhen(ms: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(ms));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('weekday')} ${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')} ${timeZone}`;
}

export function dateOf(store: EndlessStore, id: number, timeZone: string): string {
  const m = store.get(id);
  if (!m) throw new RecallError(`there is no message ${id}`);
  return formatWhen(m.createdAt, timeZone);
}
