import type { RequestHandler } from 'express';

/**
 * Headers for every response (network exposure spec, 7.13; overview finding SEC-09).
 * No script CSP yet: the app and the doc viewer render Markdown and HTML, and a strict
 * `script-src` needs its own pass over the client.
 */
export const securityHeaders: RequestHandler = (_req, res, next) => {
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
};
