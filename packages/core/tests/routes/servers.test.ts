import { describe, it, expect } from 'vitest';
import { parseServers } from '../../src/routes/servers.js';

describe('parseServers', () => {
  it('returns [] when unset or empty', () => {
    expect(parseServers(undefined)).toEqual([]);
    expect(parseServers('')).toEqual([]);
    expect(parseServers('   ')).toEqual([]);
  });

  it('parses the simple "Label=origin,Label2=origin2" format', () => {
    expect(parseServers('MacBook=http://a:3456, Mac mini=http://b:3456')).toEqual([
      { label: 'MacBook', origin: 'http://a:3456' },
      { label: 'Mac mini', origin: 'http://b:3456' },
    ]);
  });

  it('parses a JSON array', () => {
    expect(parseServers('[{"label":"X","origin":"http://x:3456"}]')).toEqual([
      { label: 'X', origin: 'http://x:3456' },
    ]);
  });

  it('ignores malformed entries', () => {
    expect(parseServers('noequals, =http://x, Y=')).toEqual([]);
    expect(parseServers('not-json-[')).toEqual([]);
    expect(parseServers('[broken')).toEqual([]);
  });
});
