import { describe, it, expect } from 'vitest';
import { deviceLabelFromUserAgent } from './label.js';

describe('deviceLabelFromUserAgent', () => {
  it.each([
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1', 'iPhone · Safari'],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36', 'Mac · Chrome'],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36 Edg/130.0', 'Windows · Edge'],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:132.0) Gecko/20100101 Firefox/132.0', 'Mac · Firefox'],
    ['Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36', 'Android · Chrome'],
  ])('%s', (ua, label) => expect(deviceLabelFromUserAgent(ua)).toBe(label));

  it('falls back for a missing or odd user agent', () => {
    expect(deviceLabelFromUserAgent(undefined)).toBe('Unknown device');
    expect(deviceLabelFromUserAgent('')).toBe('Unknown device');
    expect(deviceLabelFromUserAgent('curl/8.0')).toBe('Unknown device');
  });
});
