import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AccessSection, pairLink, PAIR_ADDRESS_KEY, isLoopbackHost, phoneAddress } from './AccessSection';
import { api, ApiError } from '../../api/client';

vi.mock('qrcode', () => ({ default: { toDataURL: vi.fn() } }));
vi.mock('../../api/client', async (orig) => {
  const real = await orig<typeof import('../../api/client')>();
  return { ...real, api: { ...real.api, makePairCode: vi.fn(), getAccessAddresses: vi.fn().mockResolvedValue({ tailscale: [], lan: [] }), getDevices: vi.fn().mockResolvedValue({ devices: [], currentDeviceId: null, legacyOpen: false }), getPushSubscriptions: vi.fn().mockResolvedValue({ subscriptions: [] }) } };
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

  it('tells the user that a phone on the Tailscale address is not listed, and to use the Wi-Fi address to list it', () => {
    render(<AccessSection />);
    expect(screen.getByTestId('address-tailscale-note')).toHaveTextContent(
      'A phone on the Tailscale address needs no sign-in and is not listed. Use the Wi-Fi address to list it.');
  });

  it('never shows the token: the token details sit closed in a disclosure that points at the CLI', () => {
    render(<AccessSection />);
    const more = screen.getByRole('button', { name: /Access token/ });
    expect(more).toHaveAttribute('aria-expanded', 'false');
    expect(more).toHaveTextContent(/never shown here/);
    fireEvent.click(more);
    expect(screen.getByText('dispatch access')).toBeInTheDocument();
    expect(screen.getByText('dispatch access rotate')).toBeInTheDocument();
  });

  it('puts the address and the code in one "Sign in a phone" group', () => {
    render(<AccessSection />);
    const g = screen.getByRole('group', { name: 'Sign in a phone' });
    expect(within(g).getByLabelText('Address the phone will use')).toBeInTheDocument();
    expect(within(g).getByRole('button', { name: 'Make a code' })).toBeInTheDocument();
  });

  it('clears a live code from the screen', async () => {
    (api.makePairCode as any).mockResolvedValue({ code: 'ABCD-EFGH', expiresAt: Date.now() + 5 * 60_000 });
    render(<AccessSection />);
    fireEvent.click(screen.getByRole('button', { name: 'Make a code' }));
    await screen.findByTestId('pair-code');
    fireEvent.click(screen.getByRole('button', { name: 'Clear code' }));
    expect(screen.queryByTestId('pair-code')).toBeNull();
  });
});

describe('<AccessSection> devices', () => {
  it('shows the signed-in devices group under the code', async () => {
    render(<AccessSection />);
    expect(await screen.findByText(/No device has signed in yet/)).toBeInTheDocument();
    expect(screen.getByText('Signed-in devices')).toBeInTheDocument();
  });
});

describe('isLoopbackHost', () => {
  it.each([['localhost', true], ['LOCALHOST', true], ['127.0.0.1', true], ['127.5.6.7', true], ['::1', true], ['[::1]', true],
    ['localhost.', true], ['::ffff:127.0.0.1', true], ['[::ffff:7f00:1]', true], ['::ffff:7f12:3456', true], ['0.0.0.0', true], ['::ffff:c0a8:43c', false],
    ['192.168.4.60', false], ['mac.tail1.ts.net', false], ['100.96.27.65', false], ['localhost.example.com', false]])('%s -> %s', (h, want) => {
    expect(isLoopbackHost(h as string)).toBe(want);
  });
});

describe('isLoopbackAddress forms a browser can produce', () => {
  it('a page address that the URL parser rewrites to IPv4-mapped hex is still loopback', async () => {
    const { isLoopbackAddress } = await import('./AccessSection');
    expect(isLoopbackAddress('http://[::ffff:127.0.0.1]:3456')).toBe(true);
    expect(isLoopbackAddress('http://localhost.:3456')).toBe(true);
    expect(isLoopbackAddress('localhost:3494')).toBe(true);
    expect(isLoopbackAddress('http://192.168.4.60:3494')).toBe(false);
  });
});

describe('phoneAddress', () => {
  it('keeps the scheme and port, swaps the host, and keeps the base path', () => {
    expect(phoneAddress({ protocol: 'http:', port: '3494' }, '100.96.27.65', '')).toBe('http://100.96.27.65:3494');
    expect(phoneAddress({ protocol: 'https:', port: '' }, '192.168.4.60', '/d')).toBe('https://192.168.4.60/d');
  });
});

describe('<AccessSection> address for the phone', () => {
  const setOrigin = (href: string) => {
    const u = new URL(href);
    Object.defineProperty(window, 'location', { configurable: true, value: { origin: u.origin, protocol: u.protocol, hostname: u.hostname, port: u.port, href } });
  };
  const realLocation = window.location;
  afterEach(() => { Object.defineProperty(window, 'location', { configurable: true, value: realLocation }); });
  const box = () => screen.getByLabelText('Address the phone will use') as HTMLInputElement;

  it('on localhost, fills in the Tailscale address (preferred) with the same scheme and port, and says so', async () => {
    setOrigin('http://localhost:3494/');
    (api.getAccessAddresses as any).mockResolvedValue({ tailscale: ['100.96.27.65'], lan: ['192.168.4.60'] });
    render(<AccessSection />);
    await waitFor(() => expect(box().value).toBe('http://100.96.27.65:3494'));
    expect(screen.getByTestId('loopback-note')).toHaveTextContent(/phone cannot open localhost/i);
    expect(screen.getByTestId('loopback-note')).toHaveTextContent(/filled in/i);
  });

  it('with no Tailscale, falls back to the Wi-Fi address', async () => {
    setOrigin('http://127.0.0.1:3494/');
    (api.getAccessAddresses as any).mockResolvedValue({ tailscale: [], lan: ['192.168.4.60'] });
    render(<AccessSection />);
    await waitFor(() => expect(box().value).toBe('http://192.168.4.60:3494'));
  });

  it('with no reachable address, leaves the box and asks the user to type one', async () => {
    setOrigin('http://localhost:3494/');
    (api.getAccessAddresses as any).mockResolvedValue({ tailscale: [], lan: [] });
    render(<AccessSection />);
    expect(await screen.findByText(/type the address the phone will use/i)).toBeInTheDocument();
    expect(box().value).toBe('http://localhost:3494');
  });

  it('when the lookup fails, behaves as if no address was found', async () => {
    setOrigin('http://localhost:3494/');
    (api.getAccessAddresses as any).mockRejectedValue(new ApiError('x', 500));
    render(<AccessSection />);
    expect(await screen.findByText(/type the address the phone will use/i)).toBeInTheDocument();
  });

  it('treats a saved loopback address as unset', async () => {
    setOrigin('http://localhost:3494/');
    localStorage.setItem(PAIR_ADDRESS_KEY, 'http://localhost:3494');
    (api.getAccessAddresses as any).mockResolvedValue({ tailscale: ['100.96.27.65'], lan: [] });
    render(<AccessSection />);
    await waitFor(() => expect(box().value).toBe('http://100.96.27.65:3494'));
  });

  it('a saved address that is not loopback wins, and the lookup does not overwrite it', async () => {
    setOrigin('http://localhost:3494/');
    localStorage.setItem(PAIR_ADDRESS_KEY, 'https://d.example.com');
    (api.getAccessAddresses as any).mockResolvedValue({ tailscale: ['100.96.27.65'], lan: [] });
    render(<AccessSection />);
    await new Promise((r) => setTimeout(r, 30));
    expect(box().value).toBe('https://d.example.com');
    expect(screen.queryByTestId('loopback-note')).not.toBeInTheDocument();
  });

  it('an address the user types before the lookup returns is not overwritten', async () => {
    setOrigin('http://localhost:3494/');
    let resolve!: (v: any) => void;
    (api.getAccessAddresses as any).mockReturnValue(new Promise((r) => { resolve = r; }));
    render(<AccessSection />);
    fireEvent.change(box(), { target: { value: 'https://mine.example.com' } });
    resolve({ tailscale: ['100.96.27.65'], lan: [] });
    await new Promise((r) => setTimeout(r, 30));
    expect(box().value).toBe('https://mine.example.com');
  });

  it('does not save the filled-in address, so it is looked up again next time', async () => {
    setOrigin('http://localhost:3494/');
    (api.getAccessAddresses as any).mockResolvedValue({ tailscale: ['100.96.27.65'], lan: [] });
    render(<AccessSection />);
    await waitFor(() => expect(box().value).toBe('http://100.96.27.65:3494'));
    expect(localStorage.getItem(PAIR_ADDRESS_KEY)).toBeNull();
  });

  it('on a non-loopback origin, shows no note and does not look anything up', async () => {
    setOrigin('http://192.168.4.60:3494/');
    (api.getAccessAddresses as any).mockClear();
    render(<AccessSection />);
    expect(box().value).toBe('http://192.168.4.60:3494');
    expect(screen.queryByTestId('loopback-note')).not.toBeInTheDocument();
    expect(api.getAccessAddresses).not.toHaveBeenCalled();
  });
});
