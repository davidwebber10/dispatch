import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { TelemetrySetting } from './TelemetrySetting';
import { GeneralSection } from './GeneralSection';
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

  it('is the last row of General', async () => {
    vi.spyOn(api, 'getTelemetrySetting').mockResolvedValue({ enabled: true });
    const { container } = render(<GeneralSection />);
    await screen.findByText('Send anonymous usage stats');
    expect(container.textContent!.trimEnd().endsWith('Send anonymous usage stats')).toBe(true);
  });
});
