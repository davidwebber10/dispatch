import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { FullComposer } from './FullComposer';

describe('FullComposer', () => {
  // iOS zooms the page when a focused text box is under 16px. This box is phone only, and at a
  // text scale under 95% its 17px would go under that.
  it('the text never goes under 16px, at any text scale', () => {
    render(<FullComposer value="a long prompt" onChange={vi.fn()} onSend={vi.fn()} canSend onClose={vi.fn()} placeholder="Message…" />);
    expect((screen.getByPlaceholderText('Message…') as HTMLTextAreaElement).style.font).toContain('max(16px, var(--fs-17))');
  });
});
