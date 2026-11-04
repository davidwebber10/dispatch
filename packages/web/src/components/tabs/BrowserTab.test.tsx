import { render, screen, fireEvent } from '@testing-library/react';
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

test.each(['javascript:alert(1)', 'JavaScript:alert(1)', 'data:text/html,<script>1</script>', 'vbscript:msgbox(1)'])(
  'a stored %s URL is never loaded in the iframe or offered as an Open link',
  (url) => {
    render(<BrowserTab terminal={{ id: 't1', sessionId: 's1', type: 'browser', config: { url } } as any} />);
    const frame = document.querySelector('iframe[title="browser"]') as HTMLIFrameElement;
    expect(frame.getAttribute('src')).toBe('about:blank');
    const link = screen.getByText('Open ↗') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('about:blank');
  },
);

test('typing a javascript: URL and pressing Enter does not load it', () => {
  render(<BrowserTab terminal={{ id: 't1', sessionId: 's1', type: 'browser', config: { url: 'https://example.com' } } as any} />);
  const input = screen.getByRole('textbox');
  fireEvent.change(input, { target: { value: 'javascript:alert(1)' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  const frame = document.querySelector('iframe[title="browser"]') as HTMLIFrameElement;
  expect(frame.getAttribute('src')).toBe('about:blank');
});
