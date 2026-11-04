import { describe, it, expect } from 'vitest';
import { isFrameableUrl, isSafeDownloadUrl } from './safeUrl';

describe('isFrameableUrl: what the Browser tab may load or open', () => {
  it('allows http, https, about:blank and plain paths', () => {
    for (const u of ['https://example.com', 'http://localhost:5173/x?y=1', 'about:blank', '/api/previews/p1', 'example.com/page']) {
      expect(isFrameableUrl(u), u).toBe(true);
    }
  });

  it('blocks javascript:, data: and vbscript: in any spelling', () => {
    for (const u of [
      'javascript:alert(1)', 'JavaScript:alert(1)', '  javascript:alert(1)', 'java\tscript:alert(1)', 'java\nscript:alert(1)',
      '\u0001javascript:alert(1)', 'data:text/html,<script>1</script>', 'DATA:text/html;base64,AAAA', 'vbscript:msgbox(1)',
    ]) {
      expect(isFrameableUrl(u), JSON.stringify(u)).toBe(false);
    }
  });

  it('blocks other schemes too (file:, blob:, ftp:)', () => {
    for (const u of ['file:///etc/passwd', 'blob:https://x/1', 'ftp://example.com/a']) expect(isFrameableUrl(u), u).toBe(false);
  });
});

describe('isSafeDownloadUrl: what the image download fallback may navigate to', () => {
  it('allows data: images (chat images are data URIs), blob:, http(s) and paths', () => {
    for (const u of ['data:image/png;base64,AAAA', 'blob:https://x/1', 'https://example.com/a.png', '/api/sessions/s1/files/image?path=a.png']) {
      expect(isSafeDownloadUrl(u), u).toBe(true);
    }
  });

  it('blocks javascript: and vbscript: in any spelling', () => {
    for (const u of ['javascript:alert(1)', ' JAVASCRIPT:alert(1)', 'java\tscript:alert(1)', 'vbscript:msgbox(1)']) {
      expect(isSafeDownloadUrl(u), JSON.stringify(u)).toBe(false);
    }
  });

  it('blocks a data: URL that is not an image (it would show a page)', () => {
    expect(isSafeDownloadUrl('data:text/html,<script>1</script>')).toBe(false);
  });
});
