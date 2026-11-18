// packages/core/src/os/export-download.ts
// A company-data export that a tool call returned (`structuredContent.os === "export/v1"`), saved into
// the calling thread's workspace by the daemon, so the agent reads the whole file with code instead of
// pasting rows into its reply.
//
//   tools/call result --export/v1--> the daemon: GET <OS base><download.path> with the box headers
//                                    (the same credentials forwardToOs sends; the thread never sees them)
//                                --> <thread workspace>/exports/<safe filename>, written as the agent user
//                                --> one text item added to the result: where the file is, and how to use it
//
// Only `download.auth === "box-token"` and a path below `/api/dispatch/exports/` (one segment, no query)
// are fetched, so a tool result cannot point the box token at any other route. The body is streamed to a
// private temporary file with a size cap (caps.ts maxExportBytes), then copied into the workspace under a
// name that is claimed, never overwritten (`name.csv`, `name-2.csv`, `name-3.csv`, ...).
//
// A failure never fails the tool call: the result stays as OS sent it, plus one short note.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { maxExportBytes } from '../caps.js';
import { agentCopyFrom, agentMkdir } from '../privsep/agent-fs.js';
import { privsep, type PrivsepConfig } from '../privsep/config.js';

/** The marker of an export result (`result.structuredContent.os`). */
export const EXPORT_MARKER = 'export/v1';
/** The only OS route an export download may name. */
export const EXPORT_PATH_PREFIX = '/api/dispatch/exports/';
/** The workspace folder the files go to. */
export const EXPORTS_DIR = 'exports';
/** How many `-N` suffixes are tried before the save gives up. */
const MAX_SUFFIX = 999;
/** Columns named in the note; the rest are counted. */
const MAX_NOTE_COLUMNS = 40;

type Json = Record<string, any>;

export interface ExportDownloadDeps {
  /** OS's base address (OsConnectionsProvider.osBaseUrl). Null: not hosted. */
  osBaseUrl: () => string | null;
  /** The box's own headers (OsConnectionsProvider.boxHeaders): token and owner. */
  boxHeaders: () => Record<string, string>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** A private folder of the daemon for the temporary file (never a workload's folder). Default: the OS temp folder. */
  scratchDir?: string;
  /** The size cap in bytes (default: caps.ts maxExportBytes). */
  maxBytes?: number;
  /** The privilege separation of this box (default: the live one). */
  privsep?: PrivsepConfig | null;
}

export type ExportSaveResult =
  | { ok: true; relPath: string; file: string; bytes: number }
  | { ok: false; reason: string };

/** The export description of a tools/call result, or null when it is not one. */
export function exportOf(result: unknown): Json | null {
  const sc = (result as Json | null)?.structuredContent;
  return sc && typeof sc === 'object' && sc.os === EXPORT_MARKER ? (sc as Json) : null;
}

/** True when the path names one export on OS's export route and nothing else. */
export function isExportPath(p: unknown): p is string {
  if (typeof p !== 'string' || !p.startsWith(EXPORT_PATH_PREFIX)) return false;
  const rest = p.slice(EXPORT_PATH_PREFIX.length);
  return /^[A-Za-z0-9][A-Za-z0-9._~-]{0,199}$/.test(rest) && !rest.includes('..');
}

/**
 * A file name that is safe in any folder: the last path part only, lower case, `[a-z0-9-_.]`, no leading
 * dot, at most 120 characters, with the extension kept. Empty: `export-<id>.csv` (or `export.csv`).
 */
export function safeExportName(raw: unknown, id?: unknown): string {
  const base = typeof raw === 'string' ? raw.split(/[\\/]/).pop() ?? '' : '';
  const clean = (t: string) => t.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/-{2,}/g, '-').replace(/^[-.]+/, '').replace(/[-.]+$/, '');
  const rawExt = path.extname(base);
  const ext = rawExt.length > 1 && rawExt.length <= 16 ? `.${clean(rawExt.slice(1))}` : '';
  const stem = clean(ext ? base.slice(0, -rawExt.length) : base).slice(0, 120 - ext.length).replace(/[-.]+$/, '');
  let name = stem ? stem + (ext.length > 1 ? ext : '') : '';
  if (!name || name === '.' || name === '..') {
    const safeId = typeof id === 'string' ? id.toLowerCase().replace(/[^a-z0-9_-]+/g, '').slice(0, 40) : '';
    name = safeId ? `export-${safeId}.csv` : 'export.csv';
  }
  return name;
}

/** `name.csv` -> `name-<n>.csv` (n >= 2). */
export function suffixedName(name: string, n: number): string {
  if (n < 2) return name;
  const ext = path.extname(name);
  return ext && ext !== name ? `${name.slice(0, -ext.length)}-${n}${ext}` : `${name}-${n}`;
}

function columnNames(columns: unknown): string[] {
  if (!Array.isArray(columns)) return [];
  return columns.map((c) => (typeof c === 'string' ? c : c && typeof c === 'object' && typeof (c as Json).name === 'string' ? (c as Json).name : null))
    .filter((c): c is string => !!c);
}

/** The one text item added to the result after a save. */
export function savedNote(relPath: string, exp: Json): string {
  const rows = typeof exp.row_count === 'number' && Number.isFinite(exp.row_count) ? `${exp.row_count} rows` : 'row count unknown';
  const cols = columnNames(exp.columns);
  const shown = cols.slice(0, MAX_NOTE_COLUMNS).join(', ');
  const more = cols.length > MAX_NOTE_COLUMNS ? ` and ${cols.length - MAX_NOTE_COLUMNS} more` : '';
  const capped = exp.truncated === true ? `; the export stopped at its cap${typeof exp.cap === 'number' ? ` of ${exp.cap} rows` : ''}` : '';
  return `Saved to ${relPath} (${rows}${cols.length ? `; columns: ${shown}${more}` : ''}${capped}). Read it with code; do not paste it into the reply.`;
}

/** The short note added when the file could not be saved. */
export function failedNote(reason: string): string {
  return `The full export could not be saved to the workspace (${reason}). Use the sample rows above, or run the export again.`;
}

/** Counts the bytes that pass and stops the stream past the cap. */
function capStream(max: number): Transform & { bytes: number } {
  const t = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      (t as any).bytes += chunk.length;
      if ((t as any).bytes > max) return cb(Object.assign(new Error('too_large'), { code: 'TOO_LARGE' }));
      cb(null, chunk);
    },
  }) as Transform & { bytes: number };
  t.bytes = 0;
  return t;
}

/**
 * Download one export and save it below `<workspace>/exports`. Never throws. `extraHeaders` carries the
 * thread id, as forwardToOs sends it.
 */
export async function saveExport(
  deps: ExportDownloadDeps,
  exp: Json,
  workspace: string | null,
  extraHeaders: Record<string, string> = {},
): Promise<ExportSaveResult> {
  const download = exp.download && typeof exp.download === 'object' ? (exp.download as Json) : null;
  if (!download || download.auth !== 'box-token') return { ok: false, reason: 'the download is not a box download' };
  if (!isExportPath(download.path)) return { ok: false, reason: 'the download path is not an export path' };
  if (!workspace) return { ok: false, reason: 'the thread has no workspace' };
  const base = deps.osBaseUrl();
  if (!base) return { ok: false, reason: 'company tools are not configured on this box' };
  let url: URL;
  try {
    url = new URL(download.path, base.endsWith('/') ? base : `${base}/`);
    const baseUrl = new URL(base);
    // The path is absolute: it replaces any path of the base. Origin and path must be exactly what was checked.
    if (url.origin !== baseUrl.origin || url.pathname !== download.path || url.search || url.hash) return { ok: false, reason: 'the download path is not an export path' };
  } catch {
    return { ok: false, reason: 'the download address is not valid' };
  }
  const max = deps.maxBytes ?? maxExportBytes();
  const cfg = deps.privsep === undefined ? privsep() : deps.privsep;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? 120_000);
  let tmpDir: string | null = null;
  try {
    const res = await (deps.fetchImpl ?? fetch)(url.toString(), {
      method: 'GET',
      headers: { accept: 'text/csv, */*', ...deps.boxHeaders(), ...extraHeaders },
      redirect: 'error', // a redirect would carry the box headers to another address
      signal: controller.signal,
    });
    if (res.status !== 200) {
      try { await res.body?.cancel(); } catch { /* nothing to drain */ }
      return { ok: false, reason: res.status === 401 ? 'the box was not signed in' : res.status === 404 ? 'the export is gone or not yours' : `HTTP ${res.status}` };
    }
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > max) {
      try { await res.body?.cancel(); } catch { /* nothing to drain */ }
      return { ok: false, reason: `it is larger than the limit of ${Math.floor(max / (1024 * 1024))} MB` };
    }
    if (!res.body) return { ok: false, reason: 'the download had no body' };
    const scratch = deps.scratchDir ?? os.tmpdir();
    fs.mkdirSync(scratch, { recursive: true, mode: 0o700 });
    tmpDir = fs.mkdtempSync(path.join(scratch, 'export-'));
    const tmp = path.join(tmpDir, 'body');
    const counter = capStream(max);
    try {
      await pipeline(Readable.fromWeb(res.body as unknown as WebReadableStream), counter, fs.createWriteStream(tmp, { flags: 'wx', mode: 0o600 }));
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'TOO_LARGE') return { ok: false, reason: `it is larger than the limit of ${Math.floor(max / (1024 * 1024))} MB` };
      throw err;
    }
    // Into the workspace, as the agent user: a link planted in the workspace leads only where the agent could write.
    const dir = path.join(workspace, EXPORTS_DIR);
    agentMkdir(dir, cfg);
    const name = safeExportName(exp.filename, exp.id);
    for (let n = 1; n <= MAX_SUFFIX; n++) {
      const candidate = suffixedName(name, n);
      try {
        agentCopyFrom(tmp, path.join(dir, candidate), cfg, 'wx');
        return { ok: true, relPath: `${EXPORTS_DIR}/${candidate}`, file: path.join(dir, candidate), bytes: counter.bytes };
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST') throw err;
      }
    }
    return { ok: false, reason: 'too many files with that name' };
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    return { ok: false, reason: e?.name === 'AbortError' ? 'the download took too long' : e?.code ? `file error ${e.code}` : 'the download failed' };
  } finally {
    clearTimeout(timer);
    if (tmpDir) { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ } }
  }
}

/**
 * The tools/call answer with the export handled: the saved-file note, or the failure note. An answer
 * that is not an export comes back as it is.
 */
export async function withSavedExport(
  deps: ExportDownloadDeps,
  answer: Json,
  workspace: string | null,
  extraHeaders: Record<string, string> = {},
): Promise<Json> {
  const result = answer?.result;
  const exp = exportOf(result);
  if (!exp || !Array.isArray(result.content)) return answer;
  const saved = await saveExport(deps, exp, workspace, extraHeaders);
  const text = saved.ok ? savedNote(saved.relPath, exp) : failedNote(saved.reason);
  return { ...answer, result: { ...result, content: [...result.content, { type: 'text', text }] } };
}
