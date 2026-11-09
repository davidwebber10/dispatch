// packages/core/src/web-assets.ts
// The web client's build files, sent compressed and cached for good (2026-11-05, launch speed).
// The phone reaches the daemon directly (Tailscale), with no CDN in between to compress, so the
// 2.7 MB main script went over the wire as-is on every first launch after an update. Files under
// assets/ are content-hashed (a new build gets new names), so they can be cached forever, and each
// is compressed once, on first request, then kept in memory.
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { promisify } from 'util';
import type express from 'express';

const brotli = promisify(zlib.brotliCompress);
const gzip = promisify(zlib.gzip);

const TYPES: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};
/** Only text compresses; anything else (fonts, images) falls through to express.static. */
const COMPRESSIBLE = new Set(Object.keys(TYPES));
export const IMMUTABLE = 'public, max-age=31536000, immutable';

type Encoding = 'br' | 'gzip';

/** The best encoding the client takes: br, then gzip, else none. */
export function pickEncoding(acceptEncoding: string | undefined): Encoding | null {
  const a = (acceptEncoding ?? '').toLowerCase();
  const takes = (name: string) => a.split(',').some((p) => {
    const [enc, ...params] = p.trim().split(';');
    if (enc.trim() !== name) return false;
    const q = params.map((s) => s.trim()).find((s) => s.startsWith('q='));
    return !q || Number(q.slice(2)) > 0;
  });
  if (takes('br')) return 'br';
  if (takes('gzip')) return 'gzip';
  return null;
}

/**
 * Serves `dir`'s text files compressed (br or gzip, by Accept-Encoding) with a forever cache.
 * Anything it doesn't handle (a missing file, a font, a client that takes no encoding) goes to
 * `next()`, so express.static still answers it.
 */
export function compressedAssets(dir: string): express.RequestHandler {
  const cache = new Map<string, Promise<Buffer>>();
  const root = path.resolve(dir);
  return (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    let rel: string;
    try { rel = decodeURIComponent(req.path); } catch { return next(); }
    const file = path.resolve(root, '.' + rel);
    if (!file.startsWith(root + path.sep)) return next();
    const ext = path.extname(file);
    if (!COMPRESSIBLE.has(ext)) return next();
    const enc = pickEncoding(req.headers['accept-encoding']);
    if (!enc) return next();
    const key = `${enc}:${file}`;
    let body = cache.get(key);
    if (!body) {
      body = fs.promises.readFile(file).then((raw) => enc === 'br'
        ? brotli(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 9, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length } })
        : gzip(raw, { level: 9 }));
      cache.set(key, body);
      // A missing file must not stay cached as a failure (a rebuild may add it).
      body.catch(() => cache.delete(key));
    }
    body.then((buf) => {
      res.setHeader('Content-Type', TYPES[ext]);
      res.setHeader('Content-Encoding', enc);
      res.setHeader('Vary', 'Accept-Encoding');
      res.setHeader('Cache-Control', IMMUTABLE);
      res.setHeader('Content-Length', String(buf.length));
      if (req.method === 'HEAD') res.end(); else res.end(buf);
    }, () => next());
  };
}

/**
 * Serve index.html with `<base href>` rewritten to the mount prefix. That one tag is
 * the single source of truth: Vite builds assets with `base: './'` so they resolve
 * against it, and the client reads `document.baseURI` for its API/WebSocket prefix
 * (web/src/lib/basePath.ts). Rewriting at SERVE time — not build time — is what lets
 * one image serve every user's prefix.
 */
export function indexHtmlWithBase(html: string, basePath: string): string {
  return html.replace(/<base href="[^"]*"\s*\/?>/, `<base href="${basePath || ''}/">`);
}

/**
 * The transformed index.html, kept in memory and read again when the file changes (W1-E).
 *
 * The daemon read the file once at boot. After a web rebuild it kept sending the script names of the
 * old build, so a page that loaded then asked for files the build had removed, until a restart.
 * Each call does one `statSync`; a new mtime or size means one read and one transform.
 * A missing file, a read error or an empty file (a build that is writing it) keeps the last good copy.
 */
export function createIndexProvider(file: string, basePath: string): () => string {
  let html = '';
  let mtimeMs = -1;
  let size = -1;
  return () => {
    try {
      const stat = fs.statSync(file);
      if (stat.mtimeMs !== mtimeMs || stat.size !== size) {
        const raw = fs.readFileSync(file, 'utf8');
        if (raw.length > 0) {
          html = indexHtmlWithBase(raw, basePath);
          mtimeMs = stat.mtimeMs;
          size = stat.size;
        }
      }
    } catch { /* keep the last good copy */ }
    return html;
  };
}
