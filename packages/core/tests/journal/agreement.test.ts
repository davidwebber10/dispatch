// packages/core/tests/journal/agreement.test.ts
// The socket replay, the REST page and the resume cursor all read the message journal (W3-D), so
// they give the same items with the same sequences. A real Claude manager runs against the fake
// streaming CLI; the socket handler and the route are the real ones.
import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import { StructuredSessionManager } from '../../src/structured/manager.js';
import { wireJournal } from '../../src/journal/wire.js';
import { createJournalRouter } from '../../src/routes/journal.js';
import { handleStructuredConnection } from '../../src/ws/structured.js';
import { setDurableIdempotencyStore } from '../../src/http/idempotency.js';

const fake = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'structured', 'fake-claude-stream.mjs');
const managers: StructuredSessionManager[] = [];
afterEach(() => { for (const m of managers.splice(0)) m.killAll(); setDurableIdempotencyStore(null); });

async function threadWithTurns(turns: string[]) {
  const db = new Database(':memory:');
  initSchema(db);
  const manager = new StructuredSessionManager();
  managers.push(manager);
  const wiring = wireJournal(db, [manager]);
  manager.spawn('t1', { command: process.execPath, args: [fake], workDir: process.cwd() });
  for (const words of turns) {
    const idle = new Promise<void>((resolve) => manager.once('idle', () => resolve()));
    manager.sendMessage('t1', words);
    await idle;
  }
  const app = express();
  // The handler after the policy handler (the policy is tested in routes/journal.test.ts).
  const stack = (createJournalRouter(wiring.journal, () => true) as any).stack[0].route.stack.map((l: any) => l.handle);
  app.get('/api/terminals/:terminalId/journal', stack[stack.length - 1]);
  const socket = (query: string): any[] => {
    const sent: any[] = [];
    const ws = { readyState: 1, send: (s: string) => sent.push(JSON.parse(s)), close: () => {}, on: () => {} } as any;
    handleStructuredConnection(ws, { url: `/api/terminals/t1/structured-ws?${query}` } as any, manager, undefined, () => false, () => true, () => true);
    return sent;
  };
  return { db, manager, wiring, app, socket };
}

describe('replay, REST pages and the resume cursor agree', () => {
  it('give the same items with the same sequences', async () => {
    const t = await threadWithTurns(['STREAM 3 12', 'yes', 'STREAM 2 5', 'yes', 'last words']);
    const last = t.wiring.journal.lastSeq('t1');
    expect(last).toBeGreaterThan(20);

    // REST: every page from the newest back to the first, 7 items a page.
    const rest: any[] = [];
    let before: number | undefined;
    for (;;) {
      const res = await request(t.app).get(`/api/terminals/t1/journal?limit=7${before ? `&before=${before}` : ''}`).expect(200);
      rest.unshift(...res.body.items);
      if (!res.body.hasMore) break;
      before = res.body.items[0].seq;
    }
    expect(rest.map((i) => i.seq)).toEqual(Array.from({ length: last }, (_, i) => i + 1)); // no gap, no repeat, in order

    // The socket replay of a fresh client: one journal frame with the same items.
    const fresh = t.socket('tail=200&journal=1');
    expect(fresh[0].type).toBe('journal');
    expect(fresh[0].items).toEqual(rest);

    // A resume from every possible cursor: exactly the items after it.
    for (let after = 0; after <= last; after++) {
      const frame = t.socket(`tail=200&journal=1&after=${after}`)[0];
      expect(frame.reset).toBe(false);
      expect(frame.items).toEqual(rest.filter((i) => i.seq > after));
    }

    // REST with `after` is the same window as the resume.
    const restAfter = await request(t.app).get('/api/terminals/t1/journal?after=10&limit=500').expect(200);
    expect(restAfter.body.items).toEqual(rest.filter((i) => i.seq > 10));

    // An older client replays the ring: the events that finished an item are the same items.
    const ring = t.socket('tail=5000').filter((e) => typeof e.seq === 'number');
    expect(ring.map((e) => e.seq)).toEqual(rest.map((i) => i.seq));
    for (const event of ring) {
      const { seq, ...payload } = event;
      expect(rest[seq - 1].payload).toEqual(payload);
    }
  });

  it('two messages with the same words are two items (the history-loss class: nothing is removed by content)', async () => {
    const t = await threadWithTurns(['yes', 'yes', 'yes']);
    const res = await request(t.app).get('/api/terminals/t1/journal').expect(200);
    const users = res.body.items.filter((i: any) => i.kind === 'user');
    expect(users.map((i: any) => i.payload.message.content[0].text)).toEqual(['yes', 'yes', 'yes']);
    expect(new Set(users.map((i: any) => i.seq)).size).toBe(3);
    // The three replies have the same words too, and are three items.
    const replies = res.body.items.filter((i: any) => i.kind === 'assistant');
    expect(replies.map((i: any) => i.payload.message.content[0].text)).toEqual(['echo:yes', 'echo:yes', 'echo:yes']);
    expect(t.socket('tail=200&journal=1')[0].items).toEqual(res.body.items);
  });

  it('the sequence of a thread never repeats or goes back over many turns and a respawn', async () => {
    const t = await threadWithTurns(['one', 'STREAM 2 3', 'two']);
    const seen: number[] = [];
    t.manager.on('event', (_id: string, e: any) => { if (typeof e?.seq === 'number') seen.push(e.seq); });
    const startAt = t.wiring.journal.lastSeq('t1');
    // A respawn of the thread's process (a model switch, a crash): the sequence goes on.
    t.manager.spawn('t1', { command: process.execPath, args: [fake], workDir: process.cwd() });
    for (const words of ['three', 'STREAM 3 4', 'four']) {
      const idle = new Promise<void>((resolve) => t.manager.once('idle', () => resolve()));
      t.manager.sendMessage('t1', words);
      await idle;
    }
    expect(seen.length).toBeGreaterThan(10);
    expect(seen[0]).toBe(startAt + 1);
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBe(seen[i - 1] + 1);
    const all = t.wiring.journal.page('t1', { limit: 500 }).items.map((i) => i.seq);
    expect(all).toEqual(Array.from({ length: all.length }, (_, i) => i + 1));
  });
});
