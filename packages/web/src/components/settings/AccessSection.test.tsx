import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AccessSection, pairLink, PAIR_ADDRESS_KEY } from './AccessSection';
import { api, ApiError } from '../../api/client';

vi.mock('qrcode', () => ({ default: { toDataURL: vi.fn() } }));
vi.mock('../../api/client', async (orig) => {
  const real = await orig<typeof import('../../api/client')>();
  return { ...real, api: { ...real.api, makePairCode: vi.fn() } };
});

beforeEach(async () => {
  try { localStorage.clear(); } catch { /* ignore */ }
  ((await import('qrcode')).default.toDataURL as any).mockResolvedValue('data:image/png;base64,QR');
});
afterEach(() => { (api.makePairCode as any).mockReset(); vi.useRealTimers(); });

describe('pairLink', () => {
  it('puts the code in the fragment and trims a trailing slash', () => {
    expect(pairLink('https://d.example.com/', 'ABCD-EFGH')).toBe('https://d.example.com/#code=ABCD-EFGH');
  });
});

describe('<AccessSection>', () => {
  it('makes a code, shows it big with a QR code of the address link, and counts down', async () => {
    (api.makePairCode as any).mockResolvedValue({ code: 'ABCD-EFGH', expiresAt: Date.now() + 5 * 60_000 });
    render(<AccessSection />);
    fireEvent.change(screen.getByLabelText('Address the phone will use'), { target: { value: 'https://d.example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Make a code' }));
    expect(await screen.findByTestId('pair-code')).toHaveTextContent('ABCD-EFGH');
    expect(screen.getByText(/Expires in [45]:\d\d\. One use\./)).toBeInTheDocument();
    const QRCode = (await import('qrcode')).default;
    await waitFor(() => expect(QRCode.toDataURL).toHaveBeenCalledWith('https://d.example.com/#code=ABCD-EFGH', expect.anything()));
    expect(await screen.findByAltText(/scan with the phone/i)).toHaveAttribute('src', 'data:image/png;base64,QR');
    // The address is remembered for next time.
    expect(localStorage.getItem(PAIR_ADDRESS_KEY)).toBe('https://d.example.com');
    // The button now offers a replacement.
    expect(screen.getByRole('button', { name: 'New code' })).toBeInTheDocument();
  });

  it('drops an expired code from the screen', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    (api.makePairCode as any).mockResolvedValue({ code: 'ABCD-EFGH', expiresAt: Date.now() + 1500 });
    render(<AccessSection />);
    fireEvent.click(screen.getByRole('button', { name: 'Make a code' }));
    expect(await screen.findByTestId('pair-code')).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(2600); });
    expect(screen.queryByTestId('pair-code')).not.toBeInTheDocument();
  });

  it('says so when codes are not available (hosted box: 404)', async () => {
    (api.makePairCode as any).mockRejectedValue(new ApiError('POST /api/access/pair-code failed: 404', 404));
    render(<AccessSection />);
    fireEvent.click(screen.getByRole('button', { name: 'Make a code' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/not available/);
  });

  it('never shows the token: the section only points at the CLI for it', () => {
    render(<AccessSection />);
    expect(screen.getByText(/never shown here/)).toBeInTheDocument();
  });
});
