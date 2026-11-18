import express from 'express';
import type { RequestHandler } from 'express';
import { maxJsonBytes, maxLargeJsonBytes } from '../caps.js';

/**
 * The routes whose JSON body can be big on purpose. Everything else gets the small cap.
 * Paths are as Express sees them (the base path is already stripped).
 */
const LARGE_BODY_ROUTES: Array<{ method: string; path: RegExp }> = [
  // Agent hook events carry whole tool results (a full file read).
  { method: 'POST', path: /^\/api\/events\/[^/]+\/[^/]+\/?$/ },
  // A message to a thread, with attached images as base64 blocks.
  { method: 'POST', path: /^\/api\/terminals\/[^/]+\/message\/?$/ },
  // A Chat message with images.
  { method: 'POST', path: /^\/api\/endless\/send\/?$/ },
  // The file editor saves a whole file (it opens files up to 5 MB, and JSON escaping adds to that).
  { method: 'PUT', path: /^\/api\/sessions\/[^/]+\/files\/write\/?$/ },
  // Custom icons, a base64 PNG each.
  { method: 'PUT', path: /^\/api\/appearance\/icons\/?$/ },
  // A plugin's exported data, back in (up to 2000 documents of 256 KB each; owner only).
  { method: 'POST', path: /^\/api\/plugins\/[^/]+\/import\/?$/ },
];

/**
 * Routes that read their own raw body: the company model relay (os/model-relay.ts) forwards the bytes
 * unchanged and has its own 8 MB cap.
 */
const RAW_BODY_ROUTES: RegExp[] = [/^\/api\/os-model\//];

/** JSON body parser with a small cap, and the large cap only on the routes above. */
export function createJsonBody(): RequestHandler {
  const small = express.json({ limit: maxJsonBytes() });
  const large = express.json({ limit: maxLargeJsonBytes() });
  return (req, res, next) => {
    if (req.method === 'POST' && RAW_BODY_ROUTES.some((r) => r.test(req.path))) return next();
    const big = LARGE_BODY_ROUTES.some((r) => r.method === req.method && r.path.test(req.path));
    (big ? large : small)(req, res, next);
  };
}
