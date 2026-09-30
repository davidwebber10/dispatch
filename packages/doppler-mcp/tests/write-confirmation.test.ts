import { describe, expect, test } from 'vitest';
import { writeConfirmation } from '../src/write-confirmation.js';

// Doppler answers a set or delete with every secret in the config, raw and computed
// values included. doppler_set_secret / doppler_delete_secret return this confirmation
// instead, so neither the value that was sent nor any other value reaches the transcript.
describe('writeConfirmation', () => {
  // The tool's own arguments carry the value, and a careless spread could add Doppler's
  // response too. Only the target fields may come through.
  const noisy = {
    name: 'API_KEY',
    project: 'dispatch',
    config: 'dev',
    value: 'fake-sent-value',
    raw: 'fake-raw',
    computed: 'fake-computed',
    note: 'fake-note',
    secrets: { OTHER: { raw: 'fake-other-raw', computed: 'fake-other-computed' } },
  };

  test('a set confirms the name and nothing else', () => {
    const result = writeConfirmation('updated', noisy);
    expect(result).toEqual({ project: 'dispatch', config: 'dev', name: 'API_KEY', updated: true });
    expect(JSON.stringify(result)).not.toMatch(/fake-/);
  });

  test('a delete confirms the name and nothing else', () => {
    const result = writeConfirmation('deleted', noisy);
    expect(result).toEqual({ project: 'dispatch', config: 'dev', name: 'API_KEY', deleted: true });
    expect(JSON.stringify(result)).not.toMatch(/fake-/);
  });
});
