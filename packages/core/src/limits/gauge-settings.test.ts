import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from '../db/schema.js';
import * as appState from '../db/app-state.js';
import { get, set, sanitize, sanitizeWarn, KEY, DEFAULTS } from './gauge-settings.js';

let db: Database.Database;
beforeEach(() => { db = new Database(':memory:'); initSchema(db); });

describe('gauge settings', () => {
  it('defaults to 80 percent with the push on', () => {
    expect(get(db)).toEqual({ warnPercent: 80, pushOnWarn: true });
    expect(DEFAULTS).toEqual({ warnPercent: 80, pushOnWarn: true });
  });

  it('rounds, then clamps the threshold to 50..99', () => {
    expect(sanitizeWarn(85.4)).toBe(85);
    expect(sanitizeWarn(85.5)).toBe(86);
    expect(sanitizeWarn(30)).toBe(50);
    expect(sanitizeWarn(120)).toBe(99);
    expect(sanitizeWarn(50)).toBe(50);
    expect(sanitizeWarn(99)).toBe(99);
  });

  it('rejects anything that is not a finite number', () => {
    for (const v of ['85', null, undefined, NaN, Infinity, {}, true]) expect(sanitizeWarn(v)).toBeNull();
  });

  it('stores a patch and keeps the other field', () => {
    expect(set(db, { warnPercent: 90 })).toEqual({ warnPercent: 90, pushOnWarn: true });
    expect(set(db, { pushOnWarn: false })).toEqual({ warnPercent: 90, pushOnWarn: false });
    expect(get(db)).toEqual({ warnPercent: 90, pushOnWarn: false });
  });

  it('falls back to the defaults on a corrupt blob', () => {
    appState.set(db, KEY, '{not json');
    expect(get(db)).toEqual(DEFAULTS);
    appState.set(db, KEY, JSON.stringify({ warnPercent: 'x', pushOnWarn: 'yes' }));
    expect(get(db)).toEqual(DEFAULTS);
    expect(sanitize(null)).toEqual(DEFAULTS);
  });
});
