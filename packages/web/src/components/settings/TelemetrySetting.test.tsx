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

  it('sits right above the Multi-pane tabs row in General', async () => {
    vi.spyOn(api, 'getTelemetrySetting').mockResolvedValue({ enabled: true });
    const { container } = render(<GeneralSection />);
    await screen.findByText('Send anonymous usage stats');
    const text = container.textContent!;
    const at = text.indexOf('Send anonymous usage stats');
    const multi = text.indexOf('Multi-pane tabs');
    expect(at).toBeGreaterThan(text.indexOf('Push notifications on this device'));
    expect(multi).toBeGreaterThan(at);
    expect(text.slice(at + 'Send anonymous usage stats'.length, multi).trim()).toBe('');
  });
});
