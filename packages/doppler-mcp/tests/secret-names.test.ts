import { describe, expect, test } from 'vitest';
import { secretNames } from '../src/secret-names.js';

// doppler_list_secrets is handed to every agent thread, and Doppler's list endpoint
// returns each secret's raw and computed value. Whatever the tool returns lands in the
// transcript, so only the names may leave the MCP process.
describe('secretNames', () => {
  test('keeps only the names and drops every value field', () => {
    const body = {
      success: true,
      secrets: {
        API_KEY: {
          raw: 'fake-raw-api-key',
          computed: 'fake-computed-api-key',
          note: 'fake-note',
          rawVisibility: 'masked',
          computedVisibility: 'masked',
          someFutureField: 'fake-future-value',
        },
        DB_PASSWORD: { raw: 'fake-raw-db', computed: 'fake-computed-db' },
      },
    };
    const names = secretNames(body);
    expect(names).toEqual(['API_KEY', 'DB_PASSWORD']);
    expect(JSON.stringify(names)).not.toMatch(/fake-|masked/);
  });

  test('sorts the names', () => {
    const body = { secrets: { ZETA: { raw: 'z' }, ALPHA: { raw: 'a' }, MIDDLE: { raw: 'm' } } };
    expect(secretNames(body)).toEqual(['ALPHA', 'MIDDLE', 'ZETA']);
  });

  test('an empty secrets object gives no names', () => {
    expect(secretNames({ secrets: {} })).toEqual([]);
  });

  test('a missing or malformed secrets object gives no names, not a throw', () => {
    expect(secretNames({ success: true })).toEqual([]);
    expect(secretNames({ secrets: null })).toEqual([]);
    expect(secretNames({ secrets: ['fake-value'] })).toEqual([]);
    expect(secretNames({})).toEqual([]);
    expect(secretNames(null)).toEqual([]);
    expect(secretNames(undefined)).toEqual([]);
  });
});
