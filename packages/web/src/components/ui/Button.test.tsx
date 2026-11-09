import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { Plus } from '@phosphor-icons/react';
import { Button } from './Button';

describe('Button', () => {
  it('loading disables the button and keeps its width', () => {
    const onClick = vi.fn();
    const { rerender } = render(<Button variant="primary" size="sm" onClick={onClick}>Save changes</Button>);
    const btn = screen.getByRole('button', { name: 'Save changes' });
    expect(btn).not.toBeDisabled();
    rerender(<Button variant="primary" size="sm" loading onClick={onClick}>Save changes</Button>);
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute('aria-busy', 'true');
    fireEvent.click(btn);
    expect(onClick).not.toHaveBeenCalled();
    // The width: the label stays in the layout (ui.css hides it with `visibility`, which keeps its
    // box) and the spinner lies over it, out of the flow.
    const label = btn.querySelector('.ui-btn__label') as HTMLElement;
    expect(label).toHaveTextContent('Save changes');
    expect(btn).toHaveClass('ui-btn--loading');
    expect(btn.querySelector('.ui-btn__spinner')).not.toBeNull();
    expect(btn.querySelector('.ui-btn__spinner svg')).not.toBeNull(); // a Phosphor icon
  });

  it('renders the icon before the label', () => {
    render(<Button variant="ghost" size="sm" icon={<Plus data-testid="ico" size={13} />}>Add server</Button>);
    const btn = screen.getByRole('button', { name: 'Add server' });
    const icon = screen.getByTestId('ico');
    const label = btn.querySelector('.ui-btn__label') as HTMLElement;
    expect(icon.compareDocumentPosition(label) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(icon.closest('.ui-btn__icon')).toHaveAttribute('aria-hidden', 'true');
  });

  it('carries the variant and size as classes, not as an inline style', () => {
    render(<Button variant="danger" size="md">Remove</Button>);
    const btn = screen.getByRole('button', { name: 'Remove' });
    expect(btn).toHaveClass('ui-btn', 'ui-btn--danger', 'ui-btn--md');
    expect(btn.getAttribute('style')).toBeNull();
    expect(btn).toHaveAttribute('type', 'button'); // never an accidental form submit
  });

  it('passes button attributes through and keeps a caller class', () => {
    render(<Button variant="secondary" size="sm" className="mine" aria-label="Close it" disabled>x</Button>);
    const btn = screen.getByRole('button', { name: 'Close it' });
    expect(btn).toHaveClass('mine', 'ui-btn--secondary');
    expect(btn).toBeDisabled();
  });
});
