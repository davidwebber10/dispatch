import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AutoArchiveField } from './AutoArchiveField';
import { DEFAULT_AUTO_ARCHIVE_MS } from '../../lib/autoArchive';

describe('AutoArchiveField', () => {
  it('hides the duration input when the toggle is off', () => {
    render(<AutoArchiveField enabled={false} ms={DEFAULT_AUTO_ARCHIVE_MS} onChange={() => {}} />);
    expect(screen.queryByLabelText('Inactivity before archiving')).not.toBeInTheDocument();
  });

  it('reveals the duration input, defaulted to 12 hours, when toggled on', () => {
    const onChange = vi.fn();
    const { rerender } = render(<AutoArchiveField enabled={false} ms={DEFAULT_AUTO_ARCHIVE_MS} onChange={onChange} />);

    fireEvent.click(screen.getByRole('switch', { name: /auto-archive thread/i }));
    expect(onChange).toHaveBeenCalledWith(true, DEFAULT_AUTO_ARCHIVE_MS);

    rerender(<AutoArchiveField enabled ms={DEFAULT_AUTO_ARCHIVE_MS} onChange={onChange} />);
    expect((screen.getByLabelText('Inactivity before archiving') as HTMLInputElement).value).toBe('12');
    expect((screen.getByLabelText('Inactivity unit') as HTMLSelectElement).value).toBe('hours');
  });

  it('emits the new duration in ms when the value changes', () => {
    const onChange = vi.fn();
    render(<AutoArchiveField enabled ms={DEFAULT_AUTO_ARCHIVE_MS} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText('Inactivity before archiving'), { target: { value: '3' } });
    expect(onChange).toHaveBeenCalledWith(true, 3 * 3_600_000);
  });

  it('emits the new duration in ms when the unit changes', () => {
    const onChange = vi.fn();
    render(<AutoArchiveField enabled ms={DEFAULT_AUTO_ARCHIVE_MS} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText('Inactivity unit'), { target: { value: 'minutes' } });
    expect(onChange).toHaveBeenCalledWith(true, 12 * 60_000);
  });
});
