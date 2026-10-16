import { render, screen, fireEvent } from '@testing-library/react';
import { it, expect } from 'vitest';
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
