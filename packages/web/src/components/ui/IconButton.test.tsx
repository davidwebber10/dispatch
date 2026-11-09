import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { Trash } from '@phosphor-icons/react';
import { IconButton } from './IconButton';

const css = fs.readFileSync(path.resolve(__dirname, 'ui.css'), 'utf8');
/** The declarations of the first rule whose selector is exactly `selector`. */
const rule = (selector: string) => {
  const m = css.match(new RegExp(`(?:^|})\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*{([^}]*)}`, 'm'));
  return m ? m[1] : '';
};

describe('IconButton', () => {
  it('has the label as accessible name', () => {
    render(<IconButton label="Remove server" icon={<Trash size={14} />} />);
    const btn = screen.getByRole('button', { name: 'Remove server' });
    expect(btn).toHaveAttribute('aria-label', 'Remove server');
    expect(btn).toHaveAttribute('title', 'Remove server');
  });

  it('has zero padding and the fixed size class', () => {
    render(<><IconButton label="Small" icon={<Trash />} size="sm" /><IconButton label="Medium" icon={<Trash />} /></>);
    expect(screen.getByRole('button', { name: 'Small' })).toHaveClass('ui-icon-btn', 'ui-icon-btn--sm');
    expect(screen.getByRole('button', { name: 'Medium' })).toHaveClass('ui-icon-btn', 'ui-icon-btn--md');
    // The squish bug (v2.8.10): a fixed-width button with the browser's own padding squeezes its SVG.
    expect(rule('.ui-icon-btn')).toMatch(/padding:\s*0\s*;/);
    expect(rule('.ui-icon-btn')).toMatch(/flex:\s*none\s*;/);
    for (const size of ['sm', 'md']) {
      const decl = rule(`.ui-icon-btn--${size}`);
      const w = decl.match(/width:\s*(\d+)px/)?.[1];
      const h = decl.match(/height:\s*(\d+)px/)?.[1];
      expect(w, `width of ${size}`).toBeTruthy();
      expect(h).toBe(w);
    }
  });

  it('hides the icon from the accessibility tree', () => {
    render(<IconButton label="Remove" icon={<Trash data-testid="i" />} />);
    expect(screen.getByTestId('i').closest('[aria-hidden="true"]')).not.toBeNull();
  });
});
