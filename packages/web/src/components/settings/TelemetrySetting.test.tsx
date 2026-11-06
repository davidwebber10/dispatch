import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { TelemetrySetting } from './TelemetrySetting';
import { AboutSection } from './AboutSection';
import { api } from '../../api/client';

beforeEach(() => { vi.restoreAllMocks(); });

describe('TelemetrySetting', () => {
  it('shows the saved state and flips it through the API', async () => {
    vi.spyOn(api, 'getTelemetrySetting').mockResolvedValue({ enabled: true });
    const put = vi.spyOn(api, 'setTelemetrySetting').mockResolvedValue({ enabled: false });
    render(<TelemetrySetting />);
    const sw = await screen.findByRole('switch', { name: 'Send anonymous usage stats' });
    await waitFor(() => expect(sw).toHaveAttribute('aria-checked', 'true'));
    fireEvent.click(sw);
    await waitFor(() => expect(put).toHaveBeenCalledWith(false));
    await waitFor(() => expect(sw).toHaveAttribute('aria-checked', 'false'));
  });

  it('is the last block of About & updates, under its own heading', async () => {
    vi.spyOn(api, 'getTelemetrySetting').mockResolvedValue({ enabled: true });
    vi.spyOn(api, 'checkUpdate').mockRejectedValue(new Error('offline'));
    const { container } = render(<AboutSection />);
    await screen.findByText('Send anonymous usage stats');
    const text = container.textContent!;
    expect(text.indexOf('USAGE STATS')).toBeGreaterThan(text.indexOf('Re-run setup wizard'));
    expect(text.trim().endsWith('Send anonymous usage stats')).toBe(true);
  });

  it('shows no heading while the daemon has not answered', () => {
    vi.spyOn(api, 'getTelemetrySetting').mockReturnValue(new Promise(() => {}));
    render(<TelemetrySetting />);
    expect(screen.queryByText('USAGE STATS')).toBeNull();
  });
});
