import { act, render } from '@testing-library/react';
import { expect, it } from 'vitest';
import { HighlightedCode } from './HighlightedCode';
import { isLanguageReady, loadAllLanguages } from '../lib/highlight';

// One file, one module state: the lazy languages load in the second test.
it('a core language is highlighted in the first render', () => {
  const { container } = render(<HighlightedCode code={'{"a": 1}'} lang="json" />);
  expect(container.querySelector('.hljs-attr')!.textContent).toBe('"a"');
  expect(isLanguageReady('sql')).toBe(false); // it loaded nothing
});

it('a lazy language shows as escaped plain text, then highlights with no new prop', async () => {
  const { container } = render(<HighlightedCode code="SELECT a < 1" lang="sql" />);
  expect(container.querySelector('code')!.innerHTML).toBe('SELECT a &lt; 1');
  await act(async () => { await loadAllLanguages(); });
  expect(container.querySelector('.hljs-keyword')!.textContent).toBe('SELECT');
});

it('no language: auto-detect, as before', () => {
  const { container } = render(<HighlightedCode code={'def f(x):\n    return x + 1'} />);
  expect(container.querySelector('[class^="hljs-"]')).not.toBeNull();
});
