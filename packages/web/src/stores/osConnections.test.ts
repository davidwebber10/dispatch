import { describe, expect, test } from 'vitest';
import { notConnectedOf, osLink } from './osConnections';

describe('company connections helpers', () => {
  test('reads not_connected from a tool result text', () => {
    expect(notConnectedOf('{"error":"not_connected","system":"google","label":"Google","connectPath":"/connections/google"}'))
      .toEqual({ system: 'google', label: 'Google', connect: '/connections/google' });
    expect(notConnectedOf('{"code":"not_connected","system":"zendesk","connect_url":"https://os.example/ask/connections"}'))
      .toEqual({ system: 'zendesk', label: 'zendesk', connect: 'https://os.example/ask/connections' });
    expect(notConnectedOf('{"error":"not_permitted","system":"x"}')).toBeNull();
    expect(notConnectedOf('plain text')).toBeNull();
  });
  test('a connect path goes under the public OS address', () => {
    expect(osLink('/connections/google', 'https://os.example/')).toBe('https://os.example/connections/google');
    expect(osLink('https://os.example/c', null)).toBe('https://os.example/c');
    expect(osLink('/c', null)).toBeNull();
  });
});
