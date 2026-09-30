import { describe, expect, test } from 'vitest';
import { secretNames } from '../src/secret-names.js';

// doppler_list_secrets is handed to every agent thread, and whatever it returns lands in
// the transcript. It reads Doppler's names-only endpoint, and secretNames reads only
// `names` from that body, so a value can never pass through it.
describe('secretNames', () => {
  test('returns the names from the names endpoint, sorted', () => {
    expect(secretNames({ names: ['ZETA', 'ALPHA', 'MIDDLE'], success: true })).toEqual(['ALPHA', 'MIDDLE', 'ZETA']);
  });

  test('keeps only string names', () => {
    const body = { names: ['API_KEY', 42, null, { raw: 'fake-raw', computed: 'fake-computed' }, 'DB_PASSWORD'] };
    const names = secretNames(body);
    expect(names).toEqual(['API_KEY', 'DB_PASSWORD']);
    expect(JSON.stringify(names)).not.toMatch(/fake-/);
  });

  test('ignores a secrets map, so a response that carries values gives no names', () => {
    const body = {
      success: true,
      secrets: {
        API_KEY: { raw: 'fake-raw-api-key', computed: 'fake-computed-api-key', note: 'fake-note' },
        DB_PASSWORD: { raw: 'fake-raw-db', computed: 'fake-computed-db' },
      },
    };
    expect(secretNames(body)).toEqual([]);
  });

  test('an empty names list gives no names', () => {
    expect(secretNames({ names: [] })).toEqual([]);
  });

  test('a missing or malformed names list gives no names, not a throw', () => {
    expect(secretNames({ success: true })).toEqual([]);
    expect(secretNames({ names: null })).toEqual([]);
    expect(secretNames({ names: 'API_KEY' })).toEqual([]);
    expect(secretNames({ names: { API_KEY: 'fake-value' } })).toEqual([]);
    expect(secretNames({})).toEqual([]);
    expect(secretNames(null)).toEqual([]);
    expect(secretNames(undefined)).toEqual([]);
  });
});
