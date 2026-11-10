import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { useState } from 'react';
import { ConfirmModal } from './ConfirmModal';

function Opener({ onConfirm = () => {}, danger = false }: { onConfirm?: () => void; danger?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>Remove plugin</button>
      <ConfirmModal open={open} danger={danger} title="Remove the plugin?" message="Its data stays." confirmLabel="Remove"
        onConfirm={() => { onConfirm(); setOpen(false); }} onCancel={() => setOpen(false)} />
    </>
  );
}
const open = () => { const b = screen.getByText('Remove plugin'); b.focus(); fireEvent.click(b); return b; };

describe('ConfirmModal', () => {
  it('is a labelled alert dialog that says what it asks', () => {
    render(<Opener />);
    open();
    const dialog = screen.getByRole('alertdialog', { name: 'Remove the plugin?' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(document.getElementById(dialog.getAttribute('aria-labelledby')!)).toHaveTextContent('Remove the plugin?');
    expect(document.getElementById(dialog.getAttribute('aria-describedby')!)).toHaveTextContent('Its data stays.');
  });

  it('takes focus, and keeps Tab between its two buttons', () => {
    render(<Opener />);
    open();
    const dialog = screen.getByRole('alertdialog');
    expect(dialog.contains(document.activeElement)).toBe(true);
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    const confirm = screen.getByRole('button', { name: 'Remove' });
    confirm.focus();
    fireEvent.keyDown(confirm, { key: 'Tab' });
    expect(document.activeElement).toBe(cancel);
    fireEvent.keyDown(cancel, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(confirm);
  });

  it('Escape cancels and focus returns to the opener', () => {
    const onConfirm = vi.fn();
    render(<Opener onConfirm={onConfirm} />);
    const opener = open();
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(onConfirm).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(opener);
  });

  it('uses the Button primitive: a quiet Cancel, and a filled confirm that is red when destructive', () => {
    render(<Opener danger />);
    open();
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveClass('ui-btn', 'ui-btn--secondary', 'ui-btn--md');
    expect(screen.getByRole('button', { name: 'Remove' })).toHaveClass('ui-btn', 'ui-btn--danger', 'ui-btn--md');
    expect(screen.getByRole('button', { name: 'Remove' }).closest('.ui-dialog-actions')).not.toBeNull();
  });

  it('a press on the backdrop cancels; a press in the dialog does not', () => {
    render(<Opener />);
    open();
    fireEvent.click(screen.getByText('Its data stays.'));
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('alertdialog').parentElement!);
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
});
