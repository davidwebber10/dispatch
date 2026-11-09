// The phone and the desktop each load only their own shell (engineering program 2026-11-09, W2-E).
// Both shell modules are mocked, so the test sees which module factory ran: a factory that ran is a
// module that the app imported.
import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

vi.setConfig({ testTimeout: 30_000 }); // each test imports the app again, in a new module registry

const ran = { desktop: 0, phone: 0 };

const realWidth = window.innerWidth;
function setWidth(px: number) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: px });
  vi.stubGlobal('matchMedia', (q: string) => {
    const max = /max-width:\s*(\d+)px/.exec(q);
    return { matches: max ? px <= Number(max[1]) : false, media: q, addEventListener() {}, removeEventListener() {} };
  });
}

beforeEach(() => {
  ran.desktop = 0; ran.phone = 0;
  // A new module registry and new factories for each test: a factory runs when its module is imported.
  vi.resetModules();
  vi.doMock('./components/layout/DesktopShell', () => { ran.desktop += 1; return { DesktopShell: () => <div data-testid="desktop-shell" /> }; });
  vi.doMock('./components/mobile/MobileApp', () => { ran.phone += 1; return { MobileApp: () => <div data-testid="phone-shell" /> }; });
  vi.stubGlobal('WebSocket', class { onopen: unknown = null; onclose: unknown = null; onmessage: unknown = null; send() {} close() {} });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => [] }));
});
afterEach(() => { vi.doUnmock('./components/layout/DesktopShell'); vi.doUnmock('./components/mobile/MobileApp'); vi.unstubAllGlobals(); setWidth(realWidth); vi.unstubAllGlobals(); });

test('the phone width does not import the desktop shell module', async () => {
  setWidth(390);
  const { default: App } = await import('./App');
  render(<App />);
  expect(await screen.findByTestId('phone-shell', {}, { timeout: 10_000 })).toBeInTheDocument();
  await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
  expect(ran.phone).toBe(1);
  expect(ran.desktop).toBe(0);
  expect(screen.queryByTestId('desktop-shell')).toBeNull();
});

test('the desktop width does not import the phone shell module', async () => {
  setWidth(1280);
  const { default: App } = await import('./App');
  render(<App />);
  expect(await screen.findByTestId('desktop-shell', {}, { timeout: 10_000 })).toBeInTheDocument();
  await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
  expect(ran.desktop).toBe(1);
  expect(ran.phone).toBe(0);
  expect(screen.queryByTestId('phone-shell')).toBeNull();
});

test('the entry asks for the shell before React renders (no wait for the first render)', async () => {
  setWidth(1280);
  await import('./App'); // import only: nothing is rendered
  await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
  expect(ran.desktop).toBe(1);
  expect(ran.phone).toBe(0);
});

test('a page that starts at a phone width and is made wide loads the desktop shell then', async () => {
  setWidth(390);
  let change: (() => void) | undefined;
  let width = 390;
  vi.stubGlobal('matchMedia', (q: string) => ({ get matches() { return width <= 768; }, media: q, addEventListener: (_: string, cb: () => void) => { change = cb; }, removeEventListener() {} }));
  const { default: App } = await import('./App');
  render(<App />);
  expect(await screen.findByTestId('phone-shell', {}, { timeout: 10_000 })).toBeInTheDocument();
  expect(ran.desktop).toBe(0);
  width = 1280;
  act(() => { change?.(); });
  expect(await screen.findByTestId('desktop-shell', {}, { timeout: 10_000 })).toBeInTheDocument();
  expect(ran.desktop).toBe(1);
});
