import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import DOMPurify from 'dompurify';
import { classifyLink } from '../lib/docLinks';
import { Markdown, splitMarkdownBlocks, STREAM_RENDER_MS } from './Markdown';
import { renderMarkdown } from '../lib/markdown';
import { loadAllLanguages } from '../lib/highlight';

// The parser, wrapped so the streamed-render tests (W2-E, at the end of the file) can count its calls.
// It still is the real parser for every test.
vi.mock('../lib/markdown', async (orig) => {
  const m = await orig<typeof import('../lib/markdown')>();
  return { ...m, renderMarkdown: vi.fn(m.renderMarkdown) };
});
import { ImageViewerHost } from './ChatImage';

it('opens a markdown image from the keyboard with Enter and with Space', () => {
  render(<Markdown source="![chart](/a.png)" />);
  const opener = screen.getByRole('button', { name: 'Open image: chart' });
  expect(opener).toHaveAttribute('tabindex', '0');
  opener.focus();
  expect(document.activeElement).toBe(opener);
  expect(fireEvent.keyDown(opener, { key: 'Enter' })).toBe(false);
  expect(screen.getByRole('dialog')).toBeInTheDocument();
  fireEvent.click(screen.getByLabelText('Close'));
  expect(screen.queryByRole('dialog')).toBeNull();
  fireEvent.keyDown(opener, { key: ' ' });
  expect(screen.getByRole('dialog')).toBeInTheDocument();
});

it('still opens a markdown image on a click', () => {
  render(<Markdown source="![chart](/a.png)" />);
  fireEvent.click(screen.getByAltText('chart'));
  expect(screen.getByRole('dialog')).toBeInTheDocument();
});

it('a linked image is one tab stop that follows the link and opens no viewer', () => {
  const { container } = render(<Markdown source="[![chart](/a.png)](https://example.com/x)" />);
  expect(screen.queryByRole('button')).toBeNull();
  expect(container.querySelectorAll('[tabindex]')).toHaveLength(0);
  expect(container.querySelectorAll('a')).toHaveLength(1);
  // jsdom has no navigation: stop the click before it tries one.
  container.querySelector('a')!.addEventListener('click', (e) => e.preventDefault());
  fireEvent.click(screen.getByAltText('chart'));
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('an image inside a link whose unsafe href was removed still opens the viewer', () => {
  const { container } = render(<Markdown source="[![chart](/a.png)](javascript:alert(1))" />);
  expect(container.querySelector('a[href]')).toBeNull();
  expect(screen.getByRole('button', { name: 'Open image: chart' })).toBeInTheDocument();
  fireEvent.click(screen.getByAltText('chart'));
  expect(screen.getByRole('dialog')).toBeInTheDocument();
});

it('a markdown image viewer stays open when the reply re-renders or is replaced', () => {
  const { rerender } = render(<ImageViewerHost><Markdown key="a" source="![chart](/a.png)" /></ImageViewerHost>);
  fireEvent.click(screen.getByAltText('chart'));
  expect(screen.getByRole('dialog')).toBeInTheDocument();
  rerender(<ImageViewerHost><Markdown key="a" source="![chart](/a.png) done" /></ImageViewerHost>);
  expect(screen.getByRole('dialog')).toBeInTheDocument();
  rerender(<ImageViewerHost><Markdown key="b" source="final reply" /></ImageViewerHost>);
  expect(screen.getByRole('dialog')).toBeInTheDocument();
});

it('the docs pass makes doc chips after the sanitizer and opens them', () => {
  const onOpen = vi.fn();
  const { container } = render(<Markdown source={'Read `docs/plans/a.md` and <img src=x onerror=alert(1)>'} docs={{ onOpen }} />);
  const chip = container.querySelector<HTMLElement>('[data-doc-path]')!;
  expect(chip.textContent).toBe('a.md');
  expect(container.innerHTML).not.toMatch(/onerror/);
  fireEvent.click(chip);
  expect(onOpen).toHaveBeenCalledWith('docs/plans/a.md', null);
});

it('no docs prop, no chips', () => {
  const { container } = render(<Markdown source={'docs/plans/a.md'} />);
  expect(container.querySelector('[data-doc-path]')).toBeNull();
});

it('a bare path keeps the text around it and reads the branch; links and code blocks stay plain', () => {
  const onOpen = vi.fn();
  const src = 'Doc: /w/dispatch/docs/x.md (branch spec/x).\n\n[docs/l.md](https://example.com/l.md)\n\n```\ndocs/in-block.md\n```';
  const { container } = render(<Markdown source={src} docs={{ onOpen }} />);
  const chips = container.querySelectorAll<HTMLElement>('[data-doc-path]');
  expect(chips).toHaveLength(1);
  expect(chips[0].tagName).toBe('BUTTON');
  expect(chips[0].title).toBe('/w/dispatch/docs/x.md');
  expect(container.querySelector('p')!.textContent).toBe('Doc: x.md (branch spec/x).');
  fireEvent.click(chips[0]);
  expect(onOpen).toHaveBeenCalledWith('/w/dispatch/docs/x.md', 'spec/x');
});

it('a path in code with other text keeps the code and puts the chip inside it', () => {
  const { container } = render(<Markdown source={'Run `cat docs/a.md` now'} docs={{ onOpen: vi.fn() }} />);
  const chip = container.querySelector<HTMLElement>('[data-doc-path]')!;
  expect(chip.closest('code')!.textContent).toBe('cat a.md');
});

it("a reply's own data-doc-path markup is not a chip", () => {
  const onOpen = vi.fn();
  const { container } = render(<Markdown source={'<span data-doc-path="docs/x.md" data-doc-branch="main">click</span>'} docs={{ onOpen }} />);
  expect(container.querySelector('[data-doc-path]')).toBeNull();
  fireEvent.click(screen.getByText('click'));
  expect(onOpen).not.toHaveBeenCalled();
});

it('the docs pass skips SVG text', () => {
  const { container } = render(<Markdown source={'<svg><a href="x"><text>docs/a.md</text></a></svg>'} docs={{ onOpen: vi.fn() }} />);
  expect(container.querySelector('[data-doc-path]')).toBeNull();
});

describe('Markdown: a link click with docs.link', () => {
  const projects = [{ id: 'p1', folder: '/Users/me/dev/app' }];
  const mount = (source: string) => {
    const onOpen = vi.fn();
    const link = (href: string) => classifyLink(href, { project: 'p1', projects });
    render(<Markdown source={source} docs={{ onOpen, link }} />);
    return onOpen;
  };
  it('opens a doc link in place and never navigates', () => {
    const onOpen = mount('[plan.md](/Users/me/dev/app/docs/plan.md:12)');
    expect(fireEvent.click(screen.getByRole('link', { name: 'plan.md' }))).toBe(false);
    expect(onOpen).toHaveBeenCalledWith('/Users/me/dev/app/docs/plan.md', null);
  });
  it('opens a web link in a new tab with noopener and noreferrer', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const onOpen = mount('[x](https://example.com/a)');
    expect(fireEvent.click(screen.getByRole('link', { name: 'x' }))).toBe(false);
    expect(open).toHaveBeenCalledWith('https://example.com/a', '_blank', 'noopener,noreferrer');
    expect(onOpen).not.toHaveBeenCalled();
    open.mockRestore();
  });
  it('does nothing for every other link, and the page does not reload', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const onOpen = mount('[a](/etc/notes.md) [b](/Users/me/dev/app/src/a.ts) [c](//evil.test/a.md) [d](#top)');
    for (const name of ['a', 'b', 'c', 'd']) expect(fireEvent.click(screen.getByRole('link', { name })), name).toBe(false);
    expect(onOpen).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    open.mockRestore();
  });
  it('does not make a chip out of the text of a link that already goes somewhere', () => {
    const { container } = render(<Markdown source="[docs/a.md](/Users/me/dev/app/docs/a.md)" docs={{ onOpen: vi.fn(), link: () => ({ kind: 'none' }) }} />);
    expect(container.querySelector('.doc-chip')).toBeNull();
  });
});

describe('Markdown: file URLs and middle clicks with docs.link', () => {
  const projects = [{ id: 'p1', folder: '/Users/me/dev/app' }];
  const mount = (source: string) => {
    const onOpen = vi.fn();
    render(<Markdown source={source} docs={{ onOpen, link: (h) => classifyLink(h, { project: 'p1', projects }) }} />);
    return onOpen;
  };
  it('keeps a file URL through the sanitizer so it opens the doc', () => {
    const onOpen = mount('[a](file:///Users/me/dev/app/docs/a.md#L3) [b](file://localhost/Users/me/dev/app/docs/b.md)');
    fireEvent.click(screen.getByRole('link', { name: 'a' }));
    fireEvent.click(screen.getByRole('link', { name: 'b' }));
    expect(onOpen.mock.calls).toEqual([['/Users/me/dev/app/docs/a.md', null], ['/Users/me/dev/app/docs/b.md', null]]);
  });
  it('a file URL does nothing when no view routes it (never a navigation)', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    render(<Markdown source="[a](file:///Users/me/dev/app/docs/a.md)" />);
    expect(fireEvent.click(screen.getByRole('link', { name: 'a' }))).toBe(false);
    expect(open).not.toHaveBeenCalled();
    open.mockRestore();
  });
  it('a middle click is routed like a click and never navigates', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const onOpen = mount('[doc](/Users/me/dev/app/docs/a.md) [src](src/a.ts) [web](https://example.com)');
    expect(fireEvent(screen.getByRole('link', { name: 'doc' }), new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 }))).toBe(false);
    expect(onOpen).toHaveBeenCalledWith('/Users/me/dev/app/docs/a.md', null);
    expect(fireEvent(screen.getByRole('link', { name: 'src' }), new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 }))).toBe(false);
    fireEvent(screen.getByRole('link', { name: 'web' }), new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 }));
    expect(open).toHaveBeenCalledWith('https://example.com', '_blank', 'noopener,noreferrer');
    expect(onOpen).toHaveBeenCalledTimes(1);
    open.mockRestore();
  });
});

describe('Markdown: link hardening with docs.link', () => {
  const projects = [{ id: 'p1', folder: '/Users/me/dev/app' }];
  const mount = (source: string) => {
    const onOpen = vi.fn();
    const { container } = render(<Markdown source={source} docs={{ onOpen, link: (h) => classifyLink(h, { project: 'p1', projects }) }} />);
    return { onOpen, container };
  };
  it('opens a bare file name with a line suffix', () => {
    const { onOpen } = mount('[plan](plan.md:12)');
    fireEvent.click(screen.getByRole('link', { name: 'plan' }));
    expect(onOpen).toHaveBeenCalledWith('plan.md', null);
  });
  it('a right click does not open anything', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const { onOpen } = mount('[doc](docs/a.md) [web](https://example.com)');
    for (const name of ['doc', 'web']) fireEvent(screen.getByRole('link', { name }), new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 2 }));
    expect(onOpen).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    open.mockRestore();
  });
  it('a doc or unsupported link keeps no raw destination for a native open; a web link keeps its href', () => {
    const { container } = mount('[doc](docs/a.md) [src](src/a.ts) [web](https://example.com/x)');
    const hrefs = [...container.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    expect(hrefs).toEqual(['#', '#', 'https://example.com/x']);
  });
});

it('a forged data-md-href on a web link cannot redirect its click', () => {
  const open = vi.spyOn(window, 'open').mockReturnValue(null);
  const projects = [{ id: 'p1', folder: '/Users/me/dev/app' }];
  render(<Markdown source={'<a href="https://trusted.example/" data-md-href="https://other.example/">T</a>'} docs={{ onOpen: vi.fn(), link: (h) => classifyLink(h, { project: 'p1', projects }) }} />);
  fireEvent.click(screen.getByRole('link', { name: 'T' }));
  expect(open).toHaveBeenCalledWith('https://trusted.example/', '_blank', 'noopener,noreferrer');
  open.mockRestore();
});

describe('remote images need a click', () => {
  it('a remote image is a placeholder with no <img> and no request until "Load image" is clicked', () => {
    const { container } = render(<Markdown source="![the chart](https://img.example.com/c.png?d=1)" />);
    expect(container.querySelector('img')).toBeNull();
    expect(container.innerHTML).not.toContain('<img');
    const btn = screen.getByRole('button', { name: /Load image/ });
    expect(btn.textContent).toContain('img.example.com');
    fireEvent.click(btn);
    const img = container.querySelector('img')!;
    expect(img).not.toBeNull();
    expect(img.getAttribute('src')).toBe('https://img.example.com/c.png?d=1');
    expect(screen.queryByRole('button', { name: /Load image/ })).toBeNull();
  });

  it('Enter and Space also load it', () => {
    const { container } = render(<Markdown source="![](https://img.example.com/a.png)" />);
    fireEvent.keyDown(screen.getByRole('button', { name: /Load image/ }), { key: 'Enter' });
    expect(container.querySelector('img')).not.toBeNull();
  });

  it('protocol-relative and http images are remote too', () => {
    const { container } = render(<Markdown source={'![a](//evil.test/a.png) ![b](http://evil.test/b.png)'} />);
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getAllByRole('button', { name: /Load image/ })).toHaveLength(2);
  });

  it('same-origin, relative, data and blob images still render at once', () => {
    const own = `${window.location.origin}/api/x.png`;
    const { container } = render(<Markdown source={`![a](/api/sessions/s/files/image?path=a.png) ![b](rel/b.png) ![c](data:image/png;base64,AAAA) ![d](${own})`} />);
    expect(container.querySelectorAll('img')).toHaveLength(4);
    expect(screen.queryByRole('button', { name: /Load image/ })).toBeNull();
  });

  it('raw HTML in a reply cannot pose as the placeholder', () => {
    const { container } = render(<Markdown source={'<span role="button" data-md-load-image="https://evil.test/x.png">Load image</span>'} />);
    fireEvent.click(container.querySelector('span')!);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('[data-md-load-image]')).toBeNull();
  });

  it('a remote image inside a link loads on click and does not follow the link', () => {
    const { container } = render(<Markdown source="[![x](https://img.example.com/a.png)](https://example.com/page)" />);
    const nav = vi.fn((e: Event) => e.preventDefault());
    container.querySelector('a')!.addEventListener('click', nav);
    fireEvent.click(screen.getByRole('button', { name: /Load image/ }));
    expect(container.querySelector('img')).not.toBeNull();
  });
});

describe('sanitizer drops style, forms and media tags', () => {
  it.each([
    ['<style>body{background:url(https://evil.test/x)}</style>text', 'style'],
    ['<form action="https://evil.test"><input name="a"><button>go</button></form>', 'form'],
    ['<p style="background:url(https://evil.test/x)">hi</p>', 'p[style]'],
    ['<video src="https://evil.test/v.mp4" poster="https://evil.test/p.png"></video>', 'video'],
    ['<audio src="https://evil.test/a.mp3"></audio>', 'audio'],
    ['<picture><source srcset="https://evil.test/a.png"></picture>', 'source'],
    ['<svg><filter id="f"><feImage href="https://evil.test/a.png"/></filter><rect filter="url(#f)"/></svg>', 'svg'],
    ['<svg><rect mask="u\\72l(https://evil.test/m.svg#a)" fill="url(&#x68;ttps://evil.test/f.svg#b)"/></svg>', 'svg'],
    ['<math href="https://evil.test/x"><mi>x</mi></math>', 'math'],
    ['<textarea>x</textarea><select><option>a</option></select>', 'textarea'],
  ])('%s', (html, selector) => {
    const { container } = render(<Markdown source={html} />);
    expect(container.querySelector(selector)).toBeNull();
    expect(container.innerHTML).not.toContain('evil.test');
  });
});

// ---------------------------------------------------------------------------------------------
// Streamed render (engineering program 2026-11-09, W2-E)
// ---------------------------------------------------------------------------------------------

/** Texts whose block-by-block HTML is the one-shot HTML at every moment of the stream. */
const STREAM_FIXTURES: Record<string, string> = {
  paragraphs: 'First paragraph with **bold** and `code`.\n\nSecond paragraph, with a [link](https://example.com/a) in it.\n\nThird.\n',
  headings: '# Title\n\nIntro text.\n\n## Part one\n\nBody one.\n\n### Detail\n\nBody two.\n\n---\n\nAfter the rule.\n',
  codeTs: 'Before.\n\n```ts\nconst a: number = 1;\n\nfunction f() {\n  return a;\n}\n```\n\nAfter the code.\n',
  codeBlankLines: '```js\nconst a = 1;\n\n\nconst b = 2;\n```\n\nText.\n\n~~~json\n{"a": 1}\n\n~~~\n',
  codePython: 'Run this:\n\n```python\nprint("x")  # note\n\nx = 1\n```\n\nDone.\n',
  codeNoLanguage: '```\nplain <b>not bold</b>\n\nmore\n```\n\nEnd.\n',
  nestedFence: '````md\n```js\nlet a;\n```\n\nstill inside\n````\n\nOutside.\n',
  table: 'Numbers:\n\n| Measure | Before | After |\n|---|---:|---:|\n| Page | 300 ms | 4 ms |\n| Loop | 310 ms | 2 ms |\n\nAfter the table.\n',
  tightList: 'Steps:\n\n- one\n- two\n  - nested\n- three\n\nAfter the list.\n',
  looseList: '- one\n\n- two\n\n  second paragraph of two\n\n- three\n\nAfter.\n',
  orderedList: '1. first\n2. second\n\n3. third after a blank line\n\nAfter.\n\n5. a new list that starts at five\n',
  listThenCode: '- item\n\n      indented code in the item\n\n- next\n\n    not in a list: indented code\n',
  blockquote: '> quoted line one\n> quoted line two\n\n> a second quote\n\nPlain.\n',
  links: 'See [the plan](https://example.com/plan), <https://example.com/auto> and [a doc](docs/plan.md).\n\nAlso `docs/readme.md` and src/lib/markdown.ts here.\n',
  images: 'A local image:\n\n![chart](/a.png)\n\nA remote one:\n\n![remote](https://example.com/x.png)\n\nA linked one: [![badge](/b.png)](https://example.com)\n',
  referenceLinks: 'See [the plan][plan] first.\n\nThen read on.\n\n[plan]: https://example.com/plan\n',
  rawHtml: 'Intro.\n\n<details>\n\n<summary>More</summary>\n\nHidden **text**.\n\n</details>\n\nAfter.\n',
  inlineHtml: 'A paragraph with <b>bold that\n\nnever closed here.\n\nNext paragraph.\n',
  insightLike: 'Text.\n\n`★ Insight ─────`\nA note.\n`───────`\n\nMore text with #12 and #7.\n',
  noTrailingNewline: 'One.\n\nTwo.\n\n```sh\nls -la',
  crlfAndTabs: 'One.\r\n\r\nTwo.\r\n\r\n\tindented with a tab\r\n\r\nThree.\r\n',
  mixed: '## Result\n\nThe change **works**.\n\n1. Build\n2. Test\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```diff\n- old\n+ new\n```\n\n> Note: done.\n\n![shot](/s.png)\n',
};

const htmlOf = (c: HTMLElement) => c.querySelector('.md-view')!.innerHTML;
const oneShot = (source: string) => { const v = render(<Markdown source={source} />); const html = htmlOf(v.container); v.unmount(); return html; };

describe('splitMarkdownBlocks', () => {
  it('the pieces join back to the text', () => {
    for (const text of Object.values(STREAM_FIXTURES)) {
      for (let n = 0; n <= text.length; n += 7) expect(splitMarkdownBlocks(text.slice(0, n)).join('')).toBe(text.slice(0, n));
      expect(splitMarkdownBlocks(text).join('')).toBe(text);
    }
  });

  it('cuts at a blank line between two paragraphs', () => {
    expect(splitMarkdownBlocks('One.\n\nTwo.\n\nThree.\n')).toEqual(['One.\n\n', 'Two.\n\n', 'Three.\n']);
  });

  it('a code fence that is still open is not split', () => {
    expect(splitMarkdownBlocks('```js\nconst a = 1;\n\nconst b = 2;\n\nconst c = 3;')).toHaveLength(1);
    expect(splitMarkdownBlocks('Text.\n\n```js\nconst a = 1;\n\nconst b = 2;\n')).toEqual(['Text.\n\n', '```js\nconst a = 1;\n\nconst b = 2;\n']);
    // A shorter fence, or the other fence character, does not close it.
    expect(splitMarkdownBlocks('````\n```\n\nx\n~~~~\n\ny\n')).toHaveLength(1);
  });

  it('a closed code fence ends its block at the next blank line', () => {
    expect(splitMarkdownBlocks('```js\na\n\nb\n```\n\nAfter.\n')).toEqual(['```js\na\n\nb\n```\n\n', 'After.\n']);
  });

  it('does not cut inside one list, before an indented line, or before a line that is still arriving', () => {
    expect(splitMarkdownBlocks('- a\n\n- b\n\n  more of b\n\n- c\n')).toHaveLength(1);
    expect(splitMarkdownBlocks('Text.\n\n    code\n')).toHaveLength(1);
    expect(splitMarkdownBlocks('- a\n\n-')).toHaveLength(1);
    expect(splitMarkdownBlocks('- a\n\nNot yet a full line')).toHaveLength(1);
    expect(splitMarkdownBlocks('- a\n\nA full line.\n')).toHaveLength(2);
  });

  it('does not cut a text with a link definition, and stops at raw HTML', () => {
    expect(splitMarkdownBlocks('See [a][b].\n\nMore.\n\n[b]: https://example.com\n')).toHaveLength(1);
    expect(splitMarkdownBlocks('One.\n\nTwo.\n\n<details>\n\nx\n\n</details>\n\nAfter.\n')).toEqual(['One.\n\n', 'Two.\n\n', '<details>\n\nx\n\n</details>\n\nAfter.\n']);
  });
});

describe('streamed render', () => {
  beforeAll(async () => { await loadAllLanguages(); }); // every code block highlights at once: no second render to wait for
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.mocked(renderMarkdown).mockClear(); });

  /** Feeds `text` in pieces of `step` characters, one piece each 20 ms, with `streaming` set. */
  function stream(text: string, step: number) {
    const view = render(<Markdown source="" streaming />);
    for (let n = step; n < text.length + step; n += step) {
      view.rerender(<Markdown source={text.slice(0, n)} streaming />);
      act(() => { vi.advanceTimersByTime(20); });
    }
    act(() => { vi.advanceTimersByTime(STREAM_RENDER_MS); });
    return view;
  }

  describe('the streamed result of a text equals the one-shot result', () => {
    for (const [name, text] of Object.entries(STREAM_FIXTURES)) {
      it(`${name}: after the stream ends`, () => {
        const want = oneShot(text);
        for (const step of [1, 3, 17]) {
          const view = stream(text, step);
          view.rerender(<Markdown source={text} streaming={false} />);
          expect(htmlOf(view.container)).toBe(want);
          view.unmount();
        }
      });
      // During the stream too (the block-by-block HTML), for every text whose blocks stand alone.
      // The three others hold a construct that spans blocks; splitMarkdownBlocks keeps those whole,
      // so they are equal as well. A failure here means a visible jump when a stream ends.
      it(`${name}: while it still streams, at the end of the text`, () => {
        const want = oneShot(text);
        const view = stream(text, 5);
        expect(htmlOf(view.container)).toBe(want);
        view.unmount();
      });
    }
  });

  it('each prefix of a streamed text renders as that prefix renders in one shot', () => {
    const text = STREAM_FIXTURES.mixed + STREAM_FIXTURES.looseList + STREAM_FIXTURES.codeBlankLines;
    const view = render(<Markdown source="" streaming />);
    for (let n = 11; n < text.length; n += 11) {
      view.rerender(<Markdown source={text.slice(0, n)} streaming />);
      act(() => { vi.advanceTimersByTime(STREAM_RENDER_MS); });
      expect(htmlOf(view.container), `prefix of ${n} characters`).toBe(oneShot(text.slice(0, n)));
    }
  });

  it('a closed block is not parsed again when text is added after it', () => {
    const parser = vi.mocked(renderMarkdown);
    const a = 'First block, **closed**.\n\n';
    const b = '```ts\nconst closed = 2;\n```\n\n';
    const view = render(<Markdown source={a} streaming />);
    const grow = (source: string) => { view.rerender(<Markdown source={source} streaming />); act(() => { vi.advanceTimersByTime(STREAM_RENDER_MS); }); };
    grow(a + b);
    grow(a + b + 'Third block starts.\n');
    parser.mockClear();
    grow(a + b + 'Third block starts.\nAnd it grows.\n');
    grow(a + b + 'Third block starts.\nAnd it grows.\nAnd again.\n');
    grow(a + b + 'Third block starts.\nAnd it grows.\nAnd again.\n\nFourth.\n');
    const parsed = parser.mock.calls.map((c) => c[0]);
    expect(parsed.filter((t) => t === a)).toHaveLength(0);
    expect(parsed.filter((t) => t === b)).toHaveLength(0);
    // One parser call per render, for the open block; the third block is parsed once more when it closes.
    expect(parsed).toEqual([
      'Third block starts.\nAnd it grows.\n',
      'Third block starts.\nAnd it grows.\nAnd again.\n',
      'Third block starts.\nAnd it grows.\nAnd again.\n\n',
      'Fourth.\n',
    ]);
    // Over the whole stream each closed block went to the parser one time as a closed block.
    expect(htmlOf(view.container)).toBe(oneShot(a + b + 'Third block starts.\nAnd it grows.\nAnd again.\n\nFourth.\n'));
  });

  it('sanitize runs once per block per render', () => {
    const sanitize = vi.spyOn(DOMPurify, 'sanitize');
    try {
      const text = 'One.\n\nTwo.\n\nThree.\n\n';
      // The first streamed render of four new blocks: four passes, one for each.
      const view = render(<Markdown source={text + 'Four\n'} streaming />);
      expect(sanitize).toHaveBeenCalledTimes(4);
      sanitize.mockClear();
      view.rerender(<Markdown source={text + 'Four grows\n'} streaming />);
      act(() => { vi.advanceTimersByTime(STREAM_RENDER_MS); });
      expect(sanitize).toHaveBeenCalledTimes(1); // the open block only
      expect(sanitize.mock.calls[0][0]).toBe('<p>Four grows</p>\n');
      sanitize.mockClear();
      view.rerender(<Markdown source={text + 'Four grows\n'} streaming={false} />);
      expect(sanitize).toHaveBeenCalledTimes(1); // the stream ended: one pass over the full text
      view.unmount();
      sanitize.mockClear();
      render(<Markdown source={text} />);
      expect(sanitize).toHaveBeenCalledTimes(1); // a message from history: one pass, as before
    } finally { sanitize.mockRestore(); }
  });

  it('the text goes to the parser at most once per 100 ms while it streams', () => {
    const parser = vi.mocked(renderMarkdown);
    const view = render(<Markdown source="x" streaming />);
    parser.mockClear();
    let text = 'x';
    for (let i = 0; i < 200; i++) { // 200 deltas in one second
      text += ' word';
      view.rerender(<Markdown source={text} streaming />);
      act(() => { vi.advanceTimersByTime(5); });
    }
    expect(parser.mock.calls.length).toBeLessThanOrEqual(10);
    expect(parser.mock.calls.length).toBeGreaterThanOrEqual(8);
    act(() => { vi.advanceTimersByTime(STREAM_RENDER_MS); });
    expect(view.container.textContent!.trim()).toBe(text); // the last text is on screen with no new prop
  });

  it('without streaming every change renders at once (the behavior before W2-E)', () => {
    const view = render(<Markdown source="a" />);
    view.rerender(<Markdown source="ab" />);
    expect(view.container.textContent!.trim()).toBe('ab');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('chips, held images and routed links keep their behavior in a streamed block', () => {
    const onOpen = vi.fn();
    const docs = { onOpen, accept: () => true, link: (href: string) => classifyLink(href, { project: 'p1', projects: [] }) };
    const text = 'Read `docs/plan.md` first.\n\n![remote](https://example.com/x.png)\n\n[web](https://example.com/w) and more';
    const view = render(<Markdown source={text} docs={docs} streaming />);
    const want = (() => { const v = render(<Markdown source={text} docs={docs} />); const h = htmlOf(v.container); v.unmount(); return h; })();
    expect(htmlOf(view.container)).toBe(want);
    fireEvent.click(view.container.querySelector('[data-doc-path]')!);
    expect(onOpen).toHaveBeenCalledWith('docs/plan.md', null);
    // "Load image" loads that address; the kept blocks are made again with it.
    fireEvent.click(view.container.querySelector('[data-md-load-image]')!);
    expect(view.container.querySelector('img')!.getAttribute('src')).toBe('https://example.com/x.png');
  });
});

// Owner, 2026-11-13: a tap on a thread link opens that thread in the app (desktop and phone alike).
it('a click on a thread link navigates to that thread and opens no tab', async () => {
  const { useNavigation } = await import('../stores/navigation');
  const navigate = vi.fn();
  useNavigation.setState({ navigate } as never);
  const open = vi.spyOn(window, 'open').mockReturnValue(null);
  const projects = [{ id: 'p1', folder: '/Users/me/dev/app' }];
  const { container } = render(<Markdown source={'See [Fix login](/p/proj-1/t/thr-9).'} docs={{ onOpen: vi.fn(), link: (h) => classifyLink(h, { project: null, projects }) }} />);
  expect(container.querySelector('a')!.getAttribute('href')).toBe('#'); // no raw app address for a native open
  fireEvent.click(screen.getByRole('link', { name: 'Fix login' }));
  expect(navigate).toHaveBeenCalledWith({ view: 'workspace', projectId: 'proj-1', threadId: 'thr-9' });
  expect(open).not.toHaveBeenCalled();
  open.mockRestore();
});
