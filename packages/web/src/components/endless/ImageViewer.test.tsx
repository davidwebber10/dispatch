import { render, screen, fireEvent } from '@testing-library/react';
import { it, expect } from 'vitest';
import { MessageScroller } from '@shadcn/react/message-scroller';
import { EndlessRows, PendingUserRow } from './EndlessMessageRow';
import type { EndlessMessage } from '../../api/types';

const userMsg = { i: 1, id: 1, kind: 'user', text: 'look', media: ['a.png'], projectName: null } as unknown as EndlessMessage;

it('opens a sent Chat image in the lightbox and closes it with Escape', () => {
  render(<MessageScroller.Provider><MessageScroller.Root><MessageScroller.Viewport><EndlessRows messages={[userMsg]} focus={null} /></MessageScroller.Viewport></MessageScroller.Root></MessageScroller.Provider>);
  fireEvent.click(document.querySelector('img[src*="a.png"]')!);
  expect(screen.getByLabelText('Close')).toBeInTheDocument();
  fireEvent.keyDown(window, { key: 'Escape' });
  expect(screen.queryByLabelText('Close')).toBeNull();
});

it('opens a pending Chat image in the lightbox', () => {
  render(<PendingUserRow text="x" projectName={null} images={[{ media_type: 'image/png', data: 'AAAA' }]} />);
  fireEvent.click(document.querySelector('img')!);
  expect(screen.getByLabelText('Close')).toBeInTheDocument();
});
