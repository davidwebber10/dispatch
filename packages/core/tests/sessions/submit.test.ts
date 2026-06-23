import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import { SessionService } from '../../src/sessions/service.js';

describe('SessionService.submitToTerminal', () => {
  let db: Database.Database;
  let writes: Array<[string, string]>;
  let svc: SessionService;

  beforeEach(() => {
    vi.useFakeTimers();
    db = new Database(':memory:');
    initSchema(db);
    writes = [];
    const ptyManager = { write: (id: string, data: string) => writes.push([id, data]) } as any;
    svc = new SessionService(db, ptyManager);
  });
  afterEach(() => vi.useRealTimers());

  it('writes the text immediately, then a standalone Enter after a delay', () => {
    svc.submitToTerminal('term', 'what is 2 + 2');
    // Text goes first; the Enter must NOT be in the same write (that stages it).
    expect(writes).toEqual([['term', 'what is 2 + 2']]);
    vi.advanceTimersByTime(200);
    expect(writes).toEqual([['term', 'what is 2 + 2'], ['term', '\r']]);
  });
});
