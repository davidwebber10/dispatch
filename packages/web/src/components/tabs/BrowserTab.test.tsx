import { render, screen } from '@testing-library/react';
import { BrowserTab } from './BrowserTab';

test('renders an iframe and an open-in-new-tab fallback for the configured url', () => {
  render(<BrowserTab terminal={{ id: 't1', sessionId: 's1', type: 'browser', config: { url: 'https://example.com' } } as any} />);
  const frame = document.querySelector('iframe[title="browser"]') as HTMLIFrameElement;
  expect(frame).toBeTruthy();
  expect(frame.getAttribute('src')).toBe('https://example.com');
  const link = screen.getByText('Open ↗') as HTMLAnchorElement;
  expect(link.getAttribute('href')).toBe('https://example.com');
  expect(link.getAttribute('target')).toBe('_blank');
});
