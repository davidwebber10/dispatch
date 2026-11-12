import { describe, expect, test, vi } from 'vitest';
import { HOST_CONTEXT_META, hostContextIsDefault, indexHtmlWithHostContext, readHostContext, readProfile } from './host-context.js';

describe('readProfile', () => {
  test('absent or empty is developer, with no warning', () => {
    const warn = vi.fn();
    expect(readProfile({}, warn)).toBe('developer');
    expect(readProfile({ DISPATCH_PROFILE: '' }, warn)).toBe('developer');
    expect(warn).not.toHaveBeenCalled();
  });

  test('business and developer are read, in any case', () => {
    expect(readProfile({ DISPATCH_PROFILE: 'business' })).toBe('business');
    expect(readProfile({ DISPATCH_PROFILE: ' Business ' })).toBe('business');
    expect(readProfile({ DISPATCH_PROFILE: 'developer' })).toBe('developer');
  });

  test('any other value is developer, with one warning', () => {
    const warn = vi.fn();
    expect(readProfile({ DISPATCH_PROFILE: 'admin' }, warn)).toBe('developer');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('admin');
  });
});

describe('readHostContext', () => {
  test('a local install: developer, not hosted, no links', () => {
    const ctx = readHostContext({});
    expect(ctx).toEqual({ profile: 'developer', hosted: false, osBaseUrl: null, ownerEmail: null });
    expect(hostContextIsDefault(ctx)).toBe(true);
  });

  test('hosted needs both OS_BASE_URL and OS_BOX_TOKEN', () => {
    expect(readHostContext({ OS_BASE_URL: 'https://os.example' }).hosted).toBe(false);
    expect(readHostContext({ OS_BOX_TOKEN: 'x' }).hosted).toBe(false);
    expect(readHostContext({ OS_BASE_URL: 'https://os.example', OS_BOX_TOKEN: 'x' }).hosted).toBe(true);
  });

  test('osBaseUrl prefers OS_PUBLIC_URL, else OS_BASE_URL, without a trailing slash', () => {
    const env = { OS_BASE_URL: 'http://os-internal:8000/', OS_BOX_TOKEN: 'x' };
    expect(readHostContext(env).osBaseUrl).toBe('http://os-internal:8000');
    expect(readHostContext({ ...env, OS_PUBLIC_URL: 'https://os.polywood.tech/' }).osBaseUrl).toBe('https://os.polywood.tech');
  });

  test('a non-http address is never a link', () => {
    const ctx = readHostContext({ OS_BASE_URL: 'javascript:alert(1)', OS_BOX_TOKEN: 'x' });
    expect(ctx.hosted).toBe(true);
    expect(ctx.osBaseUrl).toBeNull();
  });

  test('the payload carries no secret', () => {
    const ctx = readHostContext({
      OS_BASE_URL: 'https://os.example', OS_BOX_TOKEN: 'box-secret', DISPATCH_BOX_TOKEN: 'gate-secret',
      DISPATCH_PROFILE: 'business', DISPATCH_OWNER_EMAIL: 'person@example.com',
    });
    expect(ctx).toEqual({ profile: 'business', hosted: true, osBaseUrl: 'https://os.example', ownerEmail: 'person@example.com' });
    expect(JSON.stringify(ctx)).not.toMatch(/secret/);
  });
});

describe('indexHtmlWithHostContext', () => {
  const html = '<html><head><title>Dispatch</title></head><body></body></html>';

  test('a default context leaves the page byte for byte', () => {
    expect(indexHtmlWithHostContext(html, readHostContext({}))).toBe(html);
  });

  test('a hosted context adds one escaped meta before </head>', () => {
    const out = indexHtmlWithHostContext(html, { profile: 'business', hosted: true, osBaseUrl: 'https://os.example/?a="b"&c=<d>', ownerEmail: null });
    expect(out).toContain(`<meta name="${HOST_CONTEXT_META}" content="`);
    expect(out.indexOf(HOST_CONTEXT_META)).toBeLessThan(out.indexOf('</head>'));
    const content = out.match(/content="([^"]*)"/)![1];
    expect(content).not.toMatch(/[<>"]/);
    const decoded = content.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    expect(JSON.parse(decoded).osBaseUrl).toBe('https://os.example/?a="b"&c=<d>');
  });
});

import { contentSecurityPolicy, osOriginFor } from '../auth/security-headers.js';
describe('the page may ask OS for its app list', () => {
  test('a hosted box names the OS origin in connect-src; a local install adds nothing', () => {
    expect(osOriginFor({})).toBe('');
    const origin = osOriginFor({ OS_BASE_URL: 'http://os-internal:8000', OS_PUBLIC_URL: 'https://os.example/x', OS_BOX_TOKEN: 't' });
    expect(origin).toBe('https://os.example');
    expect(contentSecurityPolicy('box.example', origin)).toContain("connect-src 'self' ws://box.example wss://box.example https://os.example");
    expect(contentSecurityPolicy('box.example', '')).toContain("connect-src 'self' ws://box.example wss://box.example;");
  });
});
