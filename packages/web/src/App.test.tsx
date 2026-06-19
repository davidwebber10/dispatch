import { render, screen } from '@testing-library/react';
import { beforeEach, afterEach, vi, test, expect } from 'vitest';
import App from './App';

beforeEach(() => {
  vi.stubGlobal('WebSocket', class {
    onopen: any = null; onclose: any = null; onmessage: any = null;
    send() {} close() {}
  });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => [] }));
});
afterEach(() => vi.unstubAllGlobals());

test('renders the app shell with the Dispatch brand', () => {
  render(<App />);
  expect(screen.getByText('Dispatch')).toBeInTheDocument();
});
