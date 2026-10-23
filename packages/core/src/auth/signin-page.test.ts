import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { signInPage, signInPageCsp } from './signin-page.js';

const inlineScript = (html: string) => /<script>([\s\S]*?)<\/script>/.exec(html)![1];

describe('signInPageCsp', () => {
  test.each(['', '/dispatch', '/a"b</script>'])('allows exactly the page script for base %j', (base) => {
    const hash = createHash('sha256').update(inlineScript(signInPage(base))).digest('base64');
    const csp = signInPageCsp(base);
    expect(csp).toContain(`script-src 'sha256-${hash}'`);
  });

  test('allows nothing else: no other scripts, no framing, connections to itself only', () => {
    const csp = signInPageCsp('');
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toMatch(/unsafe-inline'[^;]*;?\s*script/);
    expect(csp.match(/script-src[^;]*/)![0]).not.toContain("'self'");
  });
});
