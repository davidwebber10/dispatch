import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { classifyLink } from '../lib/docLinks';
import { Markdown } from './Markdown';
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
