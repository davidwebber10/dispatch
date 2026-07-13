import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ImageFileTab } from './ImageFileTab';
import { api } from '../../api/client';
import type { Terminal } from '../../api/types';

const terminal = {
  id: 't1',
  sessionId: 's1',
  type: 'file',
  label: 'logo.png',
  config: { path: 'assets/logo.png' },
} as unknown as Terminal;

describe('ImageFileTab', () => {
  it('renders the image from the byte route', () => {
    render(<ImageFileTab terminal={terminal} />);
    const img = screen.getAllByRole('img')[0] as HTMLImageElement;
    expect(img.getAttribute('src')).toBe(api.imageUrl('s1', 'assets/logo.png'));
  });

  it('shows the file path in the header', () => {
    render(<ImageFileTab terminal={terminal} />);
    expect(screen.getByText('assets/logo.png')).toBeInTheDocument();
  });

  it('never pulls the binary through the utf-8 read route', () => {
    const readFile = vi.spyOn(api, 'readFile');
    render(<ImageFileTab terminal={terminal} />);
    expect(readFile).not.toHaveBeenCalled();
  });
});
