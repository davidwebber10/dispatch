import { createElement } from 'react';
import { act, render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { hljs, isLanguageReady, loadLanguage, CORE_LANGUAGES, LAZY_LANGUAGES } from './highlight';
import { renderMarkdown } from './markdown';
import { Markdown } from '../components/Markdown';

// One file, one module state: the tests run in order, and the lazy languages load in the third one.
describe('highlight languages on demand', () => {
  it('the core languages are ready with no load, the others are not', () => {
    expect(CORE_LANGUAGES).toEqual(expect.arrayContaining(['javascript', 'typescript', 'json', 'bash', 'diff']));
    for (const l of CORE_LANGUAGES) expect(isLanguageReady(l)).toBe(true);
    for (const l of ['ts', 'tsx', 'js', 'sh', 'html']) expect(isLanguageReady(l)).toBe(true); // aliases of a core language
    for (const l of LAZY_LANGUAGES) expect(isLanguageReady(l)).toBe(false);
    expect(isLanguageReady('py')).toBe(false);
  });

  it('an unknown language resolves false and the block stays plain', async () => {
    const src = '```klingon\nqapla = 1 # "x"\n```';
    const { container } = render(createElement(Markdown, { source: src }));
    const before = container.innerHTML;
    expect(container.querySelector('pre code')!.textContent).toBe('qapla = 1 # "x"\n');
    expect(container.querySelector('pre [class^="hljs-"]')).toBeNull();
    let ok: boolean | undefined;
    await act(async () => { ok = await loadLanguage('klingon'); });
    expect(ok).toBe(false);
    expect(container.innerHTML).toBe(before);
    expect(isLanguageReady('python')).toBe(false); // an unknown name loads nothing
  });

  it('a loaded language highlights on the next render', async () => {
    const src = '```python\nprint("x")  # note\n```';
    const { container } = render(createElement(Markdown, { source: src }));
    // Plain first: the text is all there, with no highlight spans.
    expect(container.querySelector('pre code')!.textContent).toBe('print("x")  # note\n');
    expect(container.querySelector('pre .hljs-string')).toBeNull();
    // The component asked for the language itself; wait for it.
    await act(async () => { expect(await loadLanguage('python')).toBe(true); });
    expect(container.querySelector('pre .hljs-string')!.textContent).toBe('"x"');
    expect(container.querySelector('pre .hljs-comment')!.textContent).toBe('# note');
    expect(container.querySelector('pre code')!.className).toBe('hljs language-python');
  });

  it('one load brings every lazy language and its aliases', () => {
    for (const l of LAZY_LANGUAGES) expect(isLanguageReady(l)).toBe(true);
    for (const l of ['py', 'yml', 'md', 'golang', 'rs', 'docker', 'toml', 'conf']) expect(hljs.getLanguage(l)).toBeTruthy();
    expect(renderMarkdown('```yml\na: 1\n```')).toContain('hljs-attr');
  });
});
