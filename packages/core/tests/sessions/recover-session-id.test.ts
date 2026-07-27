// recoverSessionId's one-file adoption gained an OWNERSHIP gate: a terminal cannot own a
// transcript born before the terminal itself was created. Field case: the Databricks Order
// Proxy coordinator (created 2026-07-24) adopted the user's June 25 terminal session because
// it was the project dir's only .jsonl — "unambiguous" by count, wrong by ownership. The
// count rule (exactly one file) is unchanged; this adds the birth-time gate.
import { describe, it, expect } from 'vitest';
import { pickRecoverableSession } from '../../src/sessions/service.js';

const T0 = Date.parse('2026-07-24T16:08:38.157Z'); // terminal created

describe('pickRecoverableSession', () => {
  it('adopts the single file when it was born after the terminal was created', () => {
    expect(pickRecoverableSession([{ id: 's1', birth: T0 + 5_000 }], T0)).toBe('s1');
  });

  it('adopts within the 60s clock-skew slack before creation', () => {
    expect(pickRecoverableSession([{ id: 's1', birth: T0 - 30_000 }], T0)).toBe('s1');
  });

  it('REFUSES the single file when it predates the terminal (the June-25 adoption bug)', () => {
    const juneBirth = Date.parse('2026-06-25T18:21:02.840Z');
    expect(pickRecoverableSession([{ id: 'users-own-session', birth: juneBirth }], T0)).toBeNull();
  });

  it('refuses when the dir has zero files', () => {
    expect(pickRecoverableSession([], T0)).toBeNull();
  });

  it('refuses when the dir has 2+ files, regardless of births (existing ambiguity rule)', () => {
    expect(pickRecoverableSession([
      { id: 'a', birth: T0 + 1_000 },
      { id: 'b', birth: T0 + 2_000 },
    ], T0)).toBeNull();
  });
});
