// packages/core/tests/journal/subagents.test.ts
//
// subagents-v1 in the message journal and on the REST routes: the lifecycle frames are kept, a
// subagent's turn end closes only its own stream, one subagent pages alone, the list survives a
// restart (from the journal), the history of a subagent comes from its sidechain transcript (and is
// never a main-thread message), and the stop routes answer the manager's verdict.
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import request from 'supertest';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import { MessageJournal } from '../../src/journal/journal.js';
import { JournalRecorder } from '../../src/journal/recorder.js';
import { ClaudeStructuredSessionManager } from '../../src/structured/manager.js';
import { createSubagentsRouter } from '../../src/routes/subagents.js';
import { readSidechainEvents, readSessionBackfill } from '../../src/sessions/cc-sessions.js';
import { encodeClaudeProjectDir } from '../../src/platform/encode.js';
import type { IStructuredManager } from '../../src/structured/manager.js';
import type { SubagentInfo } from '../../src/structured/shared/subagents.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const replay = path.join(here, '..', 'structured', 'fake-claude-replay.mjs');
const fixture = (name: string) => path.join(here, '..', 'fixtures', 'subagents', `claude-subagent-${name}.jsonl`);
const kill: IStructuredManager[] = [];
afterEach(() => { for (const m of kill.splice(0)) m.killAll(); });

function journal() {
  const db = new Database(':memory:');
  initSchema(db);
  return new MessageJournal(db);
}

async function until(pred: () => boolean, ms = 8000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('the recorder', () => {
  it('keeps a subagent lifecycle frame as a notice, and a subagent turn end closes only its own stream', () => {
    const j = journal();
    const rec = new JournalRecorder(j);
    const ring: { onCommit?: (e: unknown) => void } = {};
    rec.attach('t1', ring, { wholeFrames: false });
    const push = (e: unknown) => ring.onCommit!(e);
    push({ type: 'stream_event', event: { type: 'message_start' } });
    push({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } });
    push({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'main is still talking' } } });
    push({ type: 'system', subtype: 'subagent', id: 'sub-1', state: 'working', title: 'Review' });
    push({ type: 'stream_event', event: { type: 'message_start' }, parent_tool_use_id: 'sub-1' });
    push({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, parent_tool_use_id: 'sub-1' });
    push({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'sub says' } }, parent_tool_use_id: 'sub-1' });
    push({ type: 'result', subtype: 'codex_turn', parent_tool_use_id: 'sub-1' });
    const rows = j.page('t1').items;
    expect(rows.map((r) => r.kind)).toEqual(['notice', 'assistant', 'result']);
    expect((rows[1].payload as any).parent_tool_use_id).toBe('sub-1');
    // The main block is still open (not flushed by the subagent's turn end).
    expect(rec.openEvents('t1').some((e: any) => e.event?.delta?.text === 'main is still talking')).toBe(true);
  });
});

describe('the journal pages one subagent', () => {
  it('pageAgent: only its frames and lifecycle frames, with before/after cursors', () => {
    const j = journal();
    const add = (payload: unknown, kind: 'assistant' | 'notice' | 'tool' = 'assistant') => j.append('t1', { kind, payload });
    add({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'main 1' }] } });
    const s1 = add({ type: 'system', subtype: 'subagent', id: 'A', state: 'starting' }, 'notice');
    const a1 = add({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'A 1' }] }, parent_tool_use_id: 'A' });
    add({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'B 1' }] }, parent_tool_use_id: 'B' });
    const a2 = add({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'A 2' }] }, parent_tool_use_id: 'A' });
    add({ type: 'system', subtype: 'subagent', id: 'B', state: 'done' }, 'notice');
    expect(j.pageAgent('t1', 'A').items.map((i) => i.seq)).toEqual([s1, a1, a2]);
    expect(j.pageAgent('t1', 'A', { limit: 2 })).toMatchObject({ hasMore: true });
    expect(j.pageAgent('t1', 'A', { limit: 2 }).items.map((i) => i.seq)).toEqual([a1, a2]);
    expect(j.pageAgent('t1', 'A', { afterSeq: a1 }).items.map((i) => i.seq)).toEqual([a2]);
    expect(j.pageAgent('t1', 'A', { beforeSeq: a2 }).items.map((i) => i.seq)).toEqual([s1, a1]);
    expect(j.subagentFrames('t1').map((f: any) => f.id)).toEqual(['A', 'B']);
  });
});

describe('the sidechain transcript (Claude)', () => {
  it('reads one subagent by its call id (meta file) or its own id, tagged; the main backfill still skips it; the route serves it as history', async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidechain-wd-'));
    const proj = path.join(os.homedir(), '.claude', 'projects', encodeClaudeProjectDir(workDir, 'darwin'));
    const sub = path.join(proj, 'sess-1', 'subagents');
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(proj, 'sess-1.jsonl'), [
      { type: 'user', uuid: 'u1', message: { role: 'user', content: 'hello' } },
      { type: 'assistant', uuid: 's0', isSidechain: true, message: { role: 'assistant', content: [{ type: 'text', text: 'a sidechain line in the main file' }] } },
      { type: 'assistant', uuid: 'a1', message: { role: 'assistant', content: [{ type: 'text', text: 'main reply' }] } },
    ].map((l) => JSON.stringify(l)).join('\n') + '\n');
    fs.writeFileSync(path.join(sub, 'agent-abc123.meta.json'), JSON.stringify({ agentType: 'Explore', description: 'Look', toolUseId: 'toolu_X' }));
    fs.writeFileSync(path.join(sub, 'agent-abc123.jsonl'), [
      { type: 'user', uuid: 'x1', isSidechain: true, agentId: 'abc123', message: { role: 'user', content: 'Look at a.json' } },
      { type: 'assistant', uuid: 'x2', isSidechain: true, agentId: 'abc123', message: { role: 'assistant', content: [{ type: 'text', text: 'a.json is fine' }] } },
    ].map((l) => JSON.stringify(l)).join('\n') + '\n');
    const byMeta = readSidechainEvents(workDir, 'sess-1', 'toolu_X');
    expect(byMeta).toEqual([
      { type: 'user', message: { role: 'user', content: 'Look at a.json' }, parent_tool_use_id: 'toolu_X', uuid: 'x1' },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'a.json is fine' }] }, parent_tool_use_id: 'toolu_X', uuid: 'x2' },
    ]);
    expect(readSidechainEvents(workDir, 'sess-1', 'toolu_X', 'abc123')).toEqual(byMeta);
    expect(readSidechainEvents(workDir, 'sess-1', 'toolu_unknown')).toEqual([]);
    expect(JSON.stringify(readSessionBackfill(workDir, 'sess-1'))).not.toContain('sidechain');
    // The agent journal route: no journal rows for it, so `history` is the sidechain.
    const a = express();
    const manager = { listSubagents: () => [{ id: 'toolu_X', parentId: null, harness: 'claude-code', title: 'Look', state: 'done', nativeId: 'abc123' }], isAlive: () => true } as unknown as IStructuredManager;
    a.use('/api', createSubagentsRouter({ journal: journal(), thread: () => ({ type: 'claude-code', externalId: 'sess-1', workingDir: workDir }), manager: () => manager }));
    const res = await request(a).get('/api/terminals/t1/agents/toolu_X/journal');
    expect(res.body.items).toEqual([]);
    expect(res.body.history).toEqual(byMeta);
  });
});

describe('the subagent routes', () => {
  function app(deps: Parameters<typeof createSubagentsRouter>[0]) {
    const a = express();
    a.use(express.json());
    a.use('/api', createSubagentsRouter(deps));
    return a;
  }
  const info = (id: string, state: SubagentInfo['state']): SubagentInfo => ({ id, parentId: null, harness: 'claude-code', title: id, state });

  it('lists from the journal and the live session (live wins); a running one with no live session reads stopped', async () => {
    const j = journal();
    j.append('t1', { kind: 'notice', payload: { type: 'system', subtype: 'subagent', id: 'A', parentId: null, harness: 'codex', title: 'A', state: 'working' } });
    j.append('t1', { kind: 'notice', payload: { type: 'system', subtype: 'subagent', id: 'B', parentId: null, harness: 'codex', title: 'B', state: 'working' } });
    const thread = (id: string) => (id === 't1' ? { type: 'codex', externalId: null, workingDir: null } : null);
    const dead = await request(app({ journal: j, thread, manager: () => undefined })).get('/api/terminals/t1/agents');
    expect(dead.status).toBe(200);
    expect(dead.body).toMatchObject({ live: false, running: 0 });
    expect(dead.body.agents.map((a: any) => [a.id, a.state])).toEqual([['A', 'stopped'], ['B', 'stopped']]);
    const manager = { listSubagents: () => [info('B', 'done'), info('C', 'working')], isAlive: () => true } as unknown as IStructuredManager;
    const live = await request(app({ journal: j, thread, manager: () => manager })).get('/api/terminals/t1/agents');
    expect(live.body.agents.map((a: any) => [a.id, a.state])).toEqual([['A', 'working'], ['B', 'done'], ['C', 'working']]);
    expect(live.body.running).toBe(2);
    expect((await request(app({ journal: j, thread, manager: () => manager })).get('/api/terminals/nope/agents')).status).toBe(404);
  });

  it('stop answers the manager: stopped 200, not found 404, not running 409, unsupported 501; stop-all returns its lists', async () => {
    const verdicts: Record<string, string> = { A: 'stopped', B: 'not-found', C: 'not-running', D: 'unsupported' };
    const manager = {
      isAlive: () => true, listSubagents: () => [],
      stopSubagent: async (_t: string, id: string) => verdicts[id],
      stopAllSubagents: async () => ({ stopped: ['A'], unsupported: ['D'], mainInterrupted: true }),
    } as unknown as IStructuredManager;
    const a = app({ thread: () => ({ type: 'claude-code', externalId: null, workingDir: null }), manager: () => manager });
    expect((await request(a).post('/api/terminals/t1/agents/A/stop')).status).toBe(200);
    expect((await request(a).post('/api/terminals/t1/agents/B/stop')).status).toBe(404);
    expect((await request(a).post('/api/terminals/t1/agents/C/stop')).status).toBe(409);
    expect((await request(a).post('/api/terminals/t1/agents/D/stop')).status).toBe(501);
    const all = await request(a).post('/api/terminals/t1/agents/stop-all');
    expect(all.body).toEqual({ stopped: ['A'], unsupported: ['D'], mainInterrupted: true });
    const none = app({ thread: () => ({ type: 'claude-code', externalId: null, workingDir: null }), manager: () => undefined });
    expect((await request(none).post('/api/terminals/t1/agents/A/stop')).status).toBe(409);
  });

  it('end to end on recorded Claude frames: the agent journal pages one subagent; its history falls back to the sidechain transcript', async () => {
    const j = journal();
    const m = new ClaudeStructuredSessionManager();
    m.subagentReleaseMs = 50;
    m.journal = new JournalRecorder(j);
    kill.push(m);
    m.spawn('t1', { command: process.execPath, args: [replay], workDir: process.cwd(), env: { FAKE_CLAUDE_REPLAY: fixture('parallel') } });
    let idle = false;
    m.on('idle', () => { idle = true; });
    m.sendMessage('t1', 'go');
    await until(() => idle);
    const thread = () => ({ type: 'claude-code', externalId: null, workingDir: null });
    const a = app({ journal: j, thread, manager: () => m });
    const list = await request(a).get('/api/terminals/t1/agents');
    expect(list.body.agents).toHaveLength(2);
    const [first, second] = list.body.agents;
    const page = await request(a).get(`/api/terminals/t1/agents/${first.id}/journal`);
    expect(page.status).toBe(200);
    const payloads = page.body.items.map((i: any) => i.payload);
    expect(payloads.length).toBeGreaterThan(3);
    for (const p of payloads) expect(p.parent_tool_use_id === first.id || (p.subtype === 'subagent' && p.id === first.id)).toBe(true);
    expect(payloads.some((p: any) => p.parent_tool_use_id === second.id)).toBe(false);
    expect(page.body.agent).toMatchObject({ id: first.id, state: 'done' });
    const after = await request(a).get(`/api/terminals/t1/agents/${first.id}/journal?after=${page.body.items[1].seq}`);
    expect(after.body.items.map((i: any) => i.seq)).toEqual(page.body.items.slice(2).map((i: any) => i.seq));
    expect((await request(a).get('/api/terminals/t1/agents/nope/journal')).status).toBe(404);
  });
});
