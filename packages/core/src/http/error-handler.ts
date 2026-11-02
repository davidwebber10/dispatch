import { STATUS_CODES } from 'node:http';
import type { ErrorRequestHandler } from 'express';

/**
 * The last middleware of the app. Express's own handler prints the stack trace (and with it server paths)
 * into an HTML page unless NODE_ENV is "production", and the daemon does not set that. This one answers
 * with JSON: a status and a message.
 *
 * - A client error (4xx) that body-parser or another library marks `expose` keeps its own message
 *   ("request entity too large"). Any other 4xx gets the standard text for its status.
 * - Anything else is a 500 with a fixed message. The detail goes to the daemon log only.
 */
export const jsonErrorHandler: ErrorRequestHandler = (err, req, res, next) => {
  if (res.headersSent) return next(err); // too late for a clean answer; Express closes the connection
  const raw = Number(err?.status ?? err?.statusCode);
  const status = Number.isInteger(raw) && raw >= 400 && raw < 600 ? raw : 500;
  if (status >= 500) {
    console.error(`[http] ${req.method} ${req.path} failed:`, err);
    return void res.status(status).json({ error: 'Internal server error' });
  }
  const text = STATUS_CODES[status] ?? 'Request failed';
  const generic = text.charAt(0) + text.slice(1).toLowerCase();
  const message = err?.expose === true && typeof err.message === 'string' && err.message ? err.message : generic;
  res.status(status).json({ error: message });
};
