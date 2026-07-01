import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { InputActionsMenu } from './InputActionsMenu';

it('opens the flyout and routes each action', () => {
  const onAddFile = vi.fn(); const onDictate = vi.fn();
  render(<InputActionsMenu onAddFile={onAddFile} onDictate={onDictate} />);
  fireEvent.click(screen.getByLabelText(/more input options/i));
  fireEvent.click(screen.getByText('Add file'));
  expect(onAddFile).toHaveBeenCalled();
  fireEvent.click(screen.getByLabelText(/more input options/i));
  fireEvent.click(screen.getByText('Dictate'));
  expect(onDictate).toHaveBeenCalled();
});

it('disables Dictate with a hint', () => {
  render(<InputActionsMenu onAddFile={vi.fn()} onDictate={vi.fn()} dictateDisabled dictateHint="Set up in Settings" />);
  fireEvent.click(screen.getByLabelText(/more input options/i));
  const dictate = screen.getByText('Dictate').closest('button')!;
  expect(dictate).toBeDisabled();
  expect(screen.getByText('Set up in Settings')).toBeInTheDocument();
});
