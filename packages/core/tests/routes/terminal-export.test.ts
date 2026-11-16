import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import * as terminalsDb from '../../src/db/terminals.js';
import * as sessionsDb from '../../src/db/sessions.js';
import { createApp } from '../../src/server.js';
import { configureRefusalLog } from '../../src/auth/route-policy.js';

// Owner, 2026-11-13: "Download thread": GET /api/terminals/:id/export answers the whole conversation as
// one Markdown file, for the owner only.
describe('GET /api/terminals/:id/export', () => {
  let app: any;
  let db: Database.Database;
  beforeEach(() => {
    configureRefusalLog({ log: () => {} });
    db = new Database(':memory:');
    initSchema(db);
    app = createApp({ db, skipPty: true });
    sessionsDb.create(db, { id: 'p1', provider: 'claude-code', name: 'Storefront', workingDir: '/w/store' });
    terminalsDb.create(db, { id: 't1', sessionId: 'p1', type: 'claude-code', label: 'Fix login', config: { transport: 'structured', model: 'opus' } });
  });

  // 25 messages, read in pages of the reader's own size: the export must hold all of them, oldest first.
  const fakePages = () => {
    const lines = Array.from({ length: 25 }, (_, i) => ({ kind: i % 2 ? 'assistant' : 'user', text: `message ${i}` }));
    return vi.spyOn(app._sessionService, 'getConversation').mockImplementation(async (_id: string, o: any = {}) => {
      const end = o.before ?? 25; const start = Math.max(0, end - (o.limit ?? 10));
      return { items: lines.slice(start, end), cursor: 25, startLine: start, hasMore: start > 0 } as any;
    });
  };

  it('the owner gets the whole conversation as a Markdown download', async () => {
    fakePages();
    const res = await request(app).get('/api/terminals/t1/export');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/markdown; charset=utf-8/);
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="Fix-login-\d{4}-\d{2}-\d{2}\.md"; filename\*=UTF-8''Fix-login-/);
    expect(res.headers['cache-control']).toBe('no-store');
    const text = res.text;
    expect(text.startsWith('# Fix login')).toBe(true);
    expect(text).toContain('Project: Storefront');
    expect(text).toContain('Model: opus');
    for (let i = 0; i < 25; i++) expect(text).toContain(`message ${i}`);
    expect(text.indexOf('message 0')).toBeLessThan(text.indexOf('message 24'));
  });

  it('a thread key gets 403, and an unknown thread 404', async () => {
    fakePages();
    const key = app.locals.keys.mint({ kind: 'thread', terminalId: 't1' }).key as string;
    expect((await request(app).get('/api/terminals/t1/export').set('Authorization', `Bearer ${key}`)).status).toBe(403);
    expect((await request(app).get('/api/terminals/nope/export')).status).toBe(404);
  });

  it('a thread with no messages yet gets the header and one line', async () => {
    vi.spyOn(app._sessionService, 'getConversation').mockResolvedValue({ items: [], cursor: 0, startLine: 0, hasMore: false } as any);
    const res = await request(app).get('/api/terminals/t1/export');
    expect(res.status).toBe(200);
    expect(res.text).toContain('No messages yet.');
  });

  it('a read error answers 500 with a plain message and no content', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(app._sessionService, 'getConversation').mockRejectedValue(new Error('disk'));
    const res = await request(app).get('/api/terminals/t1/export');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Could not export the thread' });
    err.mockRestore();
  });
});
