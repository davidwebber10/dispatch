// packages/core/src/http/compress.ts
// Compression for API JSON (W1-E). A phone reaches the daemon directly (Tailscale), with no CDN in
// between, so a 230 KB conversation page went over the wire as-is. `web-assets.ts` compresses the build
// files; this does the same for `res.json`.
import zlib from 'node:zlib';
import type express from 'express';
import { pickEncoding } from '../web-assets.js';

export interface JsonCompressionOptions {
  /** A body of this size or less is sent as-is. Default 1024. */
  thresholdBytes?: number;
}

/** Same output as Express's own `res.json` serializer for the app settings it honours. */
function stringify(app: express.Application, body: unknown): string | undefined {
  const replacer = app.get('json replacer');
  const spaces = app.get('json spaces');
  let json = replacer || spaces ? JSON.stringify(body, replacer, spaces) : JSON.stringify(body);
  if (typeof json === 'string' && app.get('json escape')) {
    json = json.replace(/[<>&]/g, (c) => (c === '<' ? '\\u003c' : c === '>' ? '\\u003e' : '\\u0026'));
  }
  return json;
}

function addVary(res: express.Response): void {
  const current = res.getHeader('Vary');
  const list = (Array.isArray(current) ? current.join(', ') : String(current ?? '')).split(',').map((s) => s.trim()).filter(Boolean);
  if (list.includes('*') || list.some((v) => v.toLowerCase() === 'accept-encoding')) return;
  res.setHeader('Vary', [...list, 'Accept-Encoding'].join(', '));
}

/**
 * Wraps `res.json`: a body over the threshold is sent with brotli (quality 4) or gzip, by the request's
 * Accept-Encoding. Not compressed: a small body, a response marked `Cache-Control: no-store` (secret
 * values: a compressed secret next to text the caller controls leaks its length), a response that
 * already started (a stream), a response with its own Content-Encoding, HEAD, 204 and 304.
 * The compressed buffer goes through `res.send`, so the ETag and the 304 answer stay.
 */
export function jsonCompression(opts: JsonCompressionOptions = {}): express.RequestHandler {
  const threshold = opts.thresholdBytes ?? 1024;
  return (req, res, next) => {
    const plainJson = res.json.bind(res);
    res.json = function compressedJson(body?: unknown): express.Response {
      if (res.headersSent || req.method === 'HEAD' || res.statusCode === 204 || res.statusCode === 304) return plainJson(body);
      if (res.getHeader('Content-Encoding')) return plainJson(body);
      if (/\bno-store\b/i.test(String(res.getHeader('Cache-Control') ?? ''))) return plainJson(body);
      let text: string | undefined;
      try { text = stringify(req.app, body); } catch { return plainJson(body); } // let Express report it
      if (typeof text !== 'string') return plainJson(body);
      const raw = Buffer.from(text, 'utf8');
      if (raw.length <= threshold) return plainJson(body);
      // A cache must not give the compressed copy to a client that cannot read it (and the reverse).
      addVary(res);
      const enc = pickEncoding(req.headers['accept-encoding'] as string | undefined);
      if (!enc) return plainJson(body);

      const done = (err: Error | null, out: Buffer) => {
        // The request can end while the body is compressed (an error handler answered, or the client left).
        if (res.headersSent || res.writableEnded || res.destroyed) return;
        if (err) { plainJson(body); return; }
        if (!res.getHeader('Content-Type')) res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Content-Encoding', enc);
        res.send(out);
      };
      if (enc === 'br') {
        zlib.brotliCompress(raw, { params: {
          [zlib.constants.BROTLI_PARAM_QUALITY]: 4,
          [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT,
          [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length,
        } }, done);
      } else {
        zlib.gzip(raw, { level: 6 }, done);
      }
      return res;
    };
    next();
  };
}
