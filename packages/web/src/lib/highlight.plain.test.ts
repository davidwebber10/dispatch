import { describe, expect, it } from 'vitest';
import { isLanguageReady, loadLanguage } from './highlight';
import { highlightCode, renderMarkdown } from './markdown';

// A fresh module state: no lazy language is loaded when the first test runs.
describe('before the lazy languages load', () => {
  it('highlightCode gives escaped plain text for a lazy language, and for auto-detect', () => {
    expect(isLanguageReady('sql')).toBe(false);
    expect(highlightCode('SELECT a < b & c', 'sql')).toBe('SELECT a &lt; b &amp; c');
    expect(highlightCode('x = 1 < 2')).toBe('x = 1 &lt; 2'); // auto-detect needs the full set
    expect(highlightCode('{"a":1}', 'json')).toContain('hljs-attr'); // a core language is ready
  });

  it('renderMarkdown reports the lazy languages that a text needs, and no unknown one', () => {
    const missing: string[] = [];
    const html = renderMarkdown('```py\nx = 1\n```\n\n```klingon\nq\n```\n\n```ts\nconst a = 1;\n```', (l) => missing.push(l));
    expect(missing).toEqual(['py']);
    expect(html).toContain('<code class="hljs language-py">x = 1\n</code>');
    expect(html).toContain('hljs-keyword'); // the ts block
  });

  it('after the load the same calls highlight', async () => {
    expect(await loadLanguage('py')).toBe(true);
    expect(highlightCode('SELECT 1', 'sql')).toContain('hljs-keyword');
    const missing: string[] = [];
    expect(renderMarkdown('```py\nx = 1\n```', (l) => missing.push(l))).toContain('hljs-number');
    expect(missing).toEqual([]);
  });
});
