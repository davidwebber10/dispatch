import { describe, it, expect } from 'vitest';
import { setFileHeaders, HTML_SANDBOX_CSP } from './active-content.js';

// Owner, 2026-11-25: an HTML page in the Inbox opened white. The app shows it in an <iframe> of its own
// origin, and the daemon's global X-Frame-Options: DENY forbade every frame. A file the app shows in its
// viewer may be framed by the app itself (SAMEORIGIN), and by no other site; the page keeps its sandbox.
const fakeRes = () => { const h: Record<string, string> = { 'X-Frame-Options': 'DENY' }; return { h, setHeader: (k: string, v: string) => { h[k] = v; } } as any; };

describe('setFileHeaders', () => {
  it('lets the app frame an HTML file, and keeps the HTML sandbox', () => {
    const res = fakeRes();
    setFileHeaders(res, 'text/html', HTML_SANDBOX_CSP);
    expect(res.h['X-Frame-Options']).toBe('SAMEORIGIN');
    expect(res.h['Content-Security-Policy']).toBe(HTML_SANDBOX_CSP);
    expect(res.h['Content-Security-Policy']).not.toMatch(/allow-same-origin/);
    expect(res.h['X-Content-Type-Options']).toBe('nosniff');
  });

  it('lets the app frame a pdf too', () => {
    const res = fakeRes();
    setFileHeaders(res, 'application/pdf');
    expect(res.h['X-Frame-Options']).toBe('SAMEORIGIN');
  });
});
