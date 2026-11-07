import { describe, it, expect } from 'vitest';
import { codexEffortsFor, CODEX_COMMON_EFFORTS, CODEX_ALL_EFFORTS } from './codex-efforts.js';

describe('codexEffortsFor', () => {
  it('uses the table when the app-server gave no list: ultra for Sol, Terra and Astra, not for Luna', () => {
    expect(codexEffortsFor('gpt-6-astra')).toEqual(CODEX_ALL_EFFORTS);
    expect(codexEffortsFor('gpt-5.6-sol')).toEqual(CODEX_ALL_EFFORTS);
    expect(codexEffortsFor('gpt-6-luna')).toEqual(CODEX_COMMON_EFFORTS);
    expect(codexEffortsFor('gpt-5.6-luna', null)).toEqual(CODEX_COMMON_EFFORTS);
  });
  it('prefers the app-server list for a model it lists', () => {
    expect(codexEffortsFor('gpt-6-luna', { 'gpt-6-luna': ['low', 'ultra'] })).toEqual(['low', 'ultra']);
    expect(codexEffortsFor('gpt-6-astra', { 'gpt-6-luna': ['low'] })).toEqual(CODEX_ALL_EFFORTS);
  });
  it('is the common set when the model is not known', () => {
    expect(codexEffortsFor(undefined)).toEqual(CODEX_COMMON_EFFORTS);
    expect(codexEffortsFor('gpt-future')).toEqual(CODEX_COMMON_EFFORTS);
  });
});
