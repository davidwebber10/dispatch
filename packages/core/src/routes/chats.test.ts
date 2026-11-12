import { describe, expect, test } from 'vitest';
import Database from 'better-sqlite3';
import express from 'express';
import http from 'node:http';
import { initSchema } from '../db/schema.js';
import { chatStatus, createChatsRouter, listChats } from './chats.js';

function db() {
  const d = new Database(':memory:');
  initSchema(d);
  const proj = d.prepare(`INSERT INTO sessions (id, provider, name, status, working_dir, created_at, updated_at, last_activity_at, archived_at) VALUES (?,?,?,?,?,?,?,?,?)`);
  proj.run('p1', 'claude-code', 'Chats', 'waiting', '/w', 't', 't', 't', null);
  proj.run('p2', 'claude-code', 'Reports', 'waiting', '/w2', 't', 't', 't', null);
  proj.run('p3', 'claude-code', 'Old', 'waiting', '/w3', 't', 't', 't', '2026-11-01T00:00:00Z');
  const t = d.prepare(`INSERT INTO terminals (id, session_id, type, label, status, created_at, last_activity_at, config, archived_at) VALUES (?,?,?,?,?,?,?,?,?)`);
  const pretty = JSON.stringify({ transport: 'structured', model: 'sonnet' });
  t.run('c1', 'p1', 'claude-code', 'Orders this week', 'working', '2026-11-10T09:00:00Z', '2026-11-11T09:00:00Z', pretty, null);
  t.run('c2', 'p2', 'codex', 'Ticket summary', 'needs_input', '2026-11-10T09:00:00Z', '2026-11-11T10:00:00Z', JSON.stringify({ transport: 'structured' }), null);
  t.run('c3', 'p1', 'claude-code', 'Idle one', 'waiting', '2026-11-09T09:00:00Z', null, pretty, null);
  t.run('cli', 'p1', 'claude-code', 'A CLI thread', 'working', 't', 't', JSON.stringify({ transport: 'pty' }), null);
  t.run('agent', 'p1', 'claude-code', 'An agent', 'working', 't', 't', JSON.stringify({ transport: 'structured', role: 'agent' }), null);
  t.run('shell', 'p1', 'shell', 'Shell', 'working', 't', 't', null, null);
  t.run('gone', 'p1', 'claude-code', 'Archived', 'waiting', 't', 't', pretty, '2026-11-01T00:00:00Z');
  t.run('oldproj', 'p3', 'claude-code', 'In an archived project', 'waiting', 't', 't', pretty, null);
  return d;
}

describe('GET /api/chats', () => {
  test('every plain chat thread of every live project, newest activity first, four plain statuses', () => {
    const chats = listChats(db());
    expect(chats.map((c) => [c.id, c.projectName, c.status, c.harness])).toEqual([
      ['c2', 'Reports', 'needs_input', 'codex'],
      ['c1', 'Chats', 'working', 'claude-code'],
      ['c3', 'Chats', 'idle', 'claude-code'],
    ]);
    expect(chats[1]).toMatchObject({ title: 'Orders this week', model: 'sonnet', lastActivityAt: '2026-11-11T09:00:00Z' });
    expect(chats[2].lastActivityAt).toBe('2026-11-09T09:00:00Z'); // no activity yet: its creation
    expect(chatStatus('stopped')).toBe('idle');
  });

  test('the route answers the list, no-store', async () => {
    const app = express();
    app.use('/api', createChatsRouter(db()));
    const server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const res = await fetch(`http://127.0.0.1:${(server.address() as any).port}/api/chats`);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect((await res.json()).chats).toHaveLength(3);
    server.close();
  });
});
