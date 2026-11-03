import { describe, it, expect } from 'vitest';
import { isAllowedPushEndpoint } from './endpoints.js';

describe('isAllowedPushEndpoint', () => {
  it.each([
    'https://web.push.apple.com/QGxyz',
    'https://fcm.googleapis.com/fcm/send/abc',
    'https://fcm.googleapis.com/wp/abc',
    'https://updates.push.services.mozilla.com/wpush/v2/abc',
    'https://wns2-par02p.notify.windows.com/w/?token=abc',
    'https://FCM.GoogleAPIs.com/fcm/send/abc',
    'https://fcm.googleapis.com:443/fcm/send/abc',
  ])('accepts %s', (url) => {
    expect(isAllowedPushEndpoint(url)).toBe(true);
  });

  it.each([
    ['plain http', 'http://web.push.apple.com/x'],
    ['an unknown host', 'https://example.com/push'],
    ['localhost', 'https://localhost/push'],
    ['a private address', 'https://127.0.0.1/push'],
    ['a look-alike suffix', 'https://evilpush.apple.com.example.com/x'],
    ['a look-alike prefix', 'https://notfcm.googleapis.com/x'],
    ['the bare apex of a wildcard host', 'https://push.apple.com/x'],
    ['a host that ends with the name but not on a dot', 'https://evilpush.apple.com/x'],
    ['a host that has the name inside the user part', 'https://fcm.googleapis.com@evil.example/x'],
    ['a user name and password', 'https://user:pw@fcm.googleapis.com/x'],
    ['a trailing-dot host', 'https://fcm.googleapis.com./x'],
    ['an odd port', 'https://fcm.googleapis.com:8443/x'],
    ['the legacy android host', 'https://android.googleapis.com/gcm/send/abc'],
    ['a name in the path', 'https://example.com/fcm.googleapis.com'],
    ['not a URL', 'fcm.googleapis.com/fcm/send/abc'],
    ['an empty string', ''],
  ])('refuses %s', (_label, url) => {
    expect(isAllowedPushEndpoint(url)).toBe(false);
  });

  it('refuses a value that is not a string', () => {
    expect(isAllowedPushEndpoint(undefined)).toBe(false);
    expect(isAllowedPushEndpoint({ toString: () => 'https://fcm.googleapis.com/x' })).toBe(false);
  });
});
