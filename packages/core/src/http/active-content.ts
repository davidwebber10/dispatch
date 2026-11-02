import type { Response } from 'express';

/**
 * File types a browser runs or renders as a page when it is opened in a tab: markup that can carry a
 * script. SVG is the one people forget, because it also works as an image.
 */
const ACTIVE_TYPES = new Set([
  'image/svg+xml', 'text/html', 'application/xhtml+xml', 'text/xml', 'application/xml', 'text/xsl', 'application/xslt+xml',
]);

export function isActiveContent(mime: string): boolean {
  return ACTIVE_TYPES.has(mime.split(';')[0].trim().toLowerCase()) || /\+xml$/i.test(mime.split(';')[0].trim());
}

/**
 * Headers for a response that sends a file the user or a thread made. Every such response says
 * `nosniff`, so the browser keeps the type we send. An active type is also sandboxed: opened directly in
 * a tab it gets an opaque origin, so a script inside it has no cookie, no app API and no access to the
 * app's page. An `<img>` or `<iframe>` that loads it is not affected, so images still show in the app.
 * `sandboxPolicy` overrides the policy for a type that needs more (HTML previews allow scripts).
 */
export function setFileHeaders(res: Response, mime: string, sandboxPolicy = 'sandbox'): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (isActiveContent(mime)) res.setHeader('Content-Security-Policy', sandboxPolicy);
}
