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
];

/** JSON body parser with a small cap, and the large cap only on the routes above. */
export function createJsonBody(): RequestHandler {
  const small = express.json({ limit: maxJsonBytes() });
  const large = express.json({ limit: maxLargeJsonBytes() });
  return (req, res, next) => {
    const big = LARGE_BODY_ROUTES.some((r) => r.method === req.method && r.path.test(req.path));
    (big ? large : small)(req, res, next);
  };
}
