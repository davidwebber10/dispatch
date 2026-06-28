import { render, screen } from '@testing-library/react';
import { test, expect } from 'vitest';
import { Modal } from './Modal';

test('dialog is responsive (maxWidth, width 100%) so it fits a mobile viewport, not a fixed 500px that overflows', () => {
  render(<Modal open onClose={() => {}} title="New thing"><div>body</div></Modal>);
  const box = screen.getByText('New thing').parentElement as HTMLElement; // the dialog box wraps the title
  expect(box.style.width).toBe('100%');
  expect(box.style.maxWidth).toBe('500px');
});

test('renders nothing when closed', () => {
  const { container } = render(<Modal open={false} onClose={() => {}} title="T"><div /></Modal>);
  expect(container.firstChild).toBeNull();
});
