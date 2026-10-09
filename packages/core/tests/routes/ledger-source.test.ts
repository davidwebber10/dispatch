// GET /api/sessions/:sessionId/ledger/:itemId/source (titles and source panel spec 2026-10-09,
// Unit 8): read-only, no caller (the network is the gate, as for the card route). Each test works
// in its own nested temporary folder: <tmp>/ledger-source-XXXX/{project,outside}.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { initSchema } from '../../src/db/schema.js';
import { createApp } from '../../src/server.js';
import * as sessionsDb from '../../src/db/sessions.js';
import * as ledgerDb from '../../src/db/ledger.js';

const PLAN = [
  '# Example plan',
  '## Background',
  'Some history.',
  '## Open owner decisions after v3.2 (the v3 table, updated 2026-10-08)',
  '| ID | Question |',
  '|---|---|',
  '| LR-6 | How many clean nights before live mode? |',
  '## Risks',
  '- The load pattern changes on Saturday.',
].join('\n');

describe('GET /ledger/:itemId/source', () => {
  let app: any;
  let db: Database.Database;
  let base: string;
  let project: string;
  const sid = 'proj-1';
  const write = (rel: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(base, rel)), { recursive: true });
    fs.writeFileSync(path.join(base, rel), text);
  };
  const add = (over: Partial<ledgerDb.CreateLedgerInput>) =>
    ledgerDb.create(db, { sessionId: sid, kind: 'decide', text: 'How many clean nights before live mode?', title: 'Clean nights before live mode', author: 'overseer', ...over });
  const get = (seq: string, query = '') => request(app).get(`/api/sessions/${sid}/ledger/${seq}/source${query}`);

  beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-source-'));
    project = path.join(base, 'project');
    write('project/docs/plans/readiness.md', PLAN);
    write('project/docs/notes.txt', 'plain');
    write('outside/secret.md', '# secret');
    db = new Database(':memory:');
    initSchema(db);
    app = createApp({ db, skipPty: true });
    sessionsDb.create(db, { id: sid, provider: 'claude-code', name: 'source', workingDir: project });
  });
  afterEach(() => { fs.rmSync(base, { recursive: true, force: true }); });

  it('a section: the file, the path, the heading, the markdown, the source ID, the flags', async () => {
    add({ sourceKind: 'plan', sourceRef: 'docs/plans/readiness.md', sourceSection: 'Open owner decisions after v3', sourceId: 'LR-6' });
    const before = ledgerDb.listBySession(db, sid);
    const res = await get('N1').expect(200);
    expect(res.body).toEqual({
      kind: 'section', file: 'readiness.md', path: 'docs/plans/readiness.md',
      heading: 'Open owner decisions after v3.2 (the v3 table, updated 2026-10-08)',
      markdown: '| ID | Question |\n|---|---|\n| LR-6 | How many clean nights before live mode? |',
      id: 'LR-6', fromMainCheckout: false, cut: false,
    });
    expect(ledgerDb.listBySession(db, sid)).toEqual(before); // read-only
  });

  it('an agent-block source reads the path part of "path#section"', async () => {
    add({ sourceKind: 'agent', sourceRef: 'Readiness planner', agentTerminalId: 'agent-1', sourceSection: 'docs/plans/readiness.md#Risks', sourceId: 'LR-6' });
    expect((await get('N1').expect(200)).body).toMatchObject({ kind: 'section', heading: 'Risks', markdown: '- The load pattern changes on Saturday.' });
  });

  it('an outline when no heading matches; ?heading= loads that section', async () => {
    add({ sourceKind: 'doc', sourceRef: 'docs/plans/readiness.md', sourceSection: 'Rollout steps' });
    expect((await get('N1').expect(200)).body).toEqual({
      kind: 'outline', file: 'readiness.md', path: 'docs/plans/readiness.md', fromMainCheckout: false,
      headings: [
        { level: 1, text: 'Example plan' }, { level: 2, text: 'Background' },
        { level: 2, text: 'Open owner decisions after v3.2 (the v3 table, updated 2026-10-08)' }, { level: 2, text: 'Risks' },
      ],
    });
    const picked = await get('N1', `?heading=${encodeURIComponent('Background')}`).expect(200);
    expect(picked.body).toMatchObject({ kind: 'section', heading: 'Background', markdown: 'Some history.', id: null });
  });

  it('the worktree is gone: the main checkout, flagged', async () => {
    add({ sourceKind: 'plan', sourceRef: '.claude/worktrees/some-plan/docs/plans/readiness.md', sourceSection: 'Risks' });
    expect((await get('N1').expect(200)).body).toMatchObject({ kind: 'section', path: 'docs/plans/readiness.md', fromMainCheckout: true });
  });

  it('file-only for a file that is not markdown', async () => {
    add({ sourceKind: 'doc', sourceRef: 'docs/notes.txt' });
    expect((await get('N1').expect(200)).body).toEqual({
      kind: 'file-only', file: 'notes.txt', path: 'docs/notes.txt', reason: 'This file is not markdown, so the panel cannot show a section of it.',
    });
  });

  it('404 "No such item": an unknown item, a bad ID, an unknown project', async () => {
    expect((await get('N9').expect(404)).body).toEqual({ error: 'No such item' });
    expect((await get('x').expect(404)).body).toEqual({ error: 'No such item' });
    expect((await request(app).get('/api/sessions/no-such-project/ledger/N1/source').expect(404)).body).toEqual({ error: 'No such item' });
  });

  it('422 "This item has no file source": a PR, the overseer, an agent without a file', async () => {
    add({ sourceKind: 'pr', sourceRef: '#26' });
    add({ sourceKind: 'overseer' });
    add({ sourceKind: 'agent', sourceRef: 'Map researcher', sourceSection: 'Q2 part' });
    for (const seq of ['N1', 'N2', 'N3']) expect((await get(seq).expect(422)).body, seq).toEqual({ error: 'This item has no file source' });
  });

  it('404 "The file is gone"', async () => {
    add({ sourceKind: 'plan', sourceRef: 'docs/plans/deleted.md', sourceSection: 'Risks' });
    expect((await get('N1').expect(404)).body).toEqual({ error: 'The file is gone' });
  });

  it('403 for a path that leads out of the project: "../", a symlink', async () => {
    fs.symlinkSync(path.join(base, 'outside/secret.md'), path.join(project, 'docs/link.md'));
    add({ sourceKind: 'agent', sourceRef: 'Readiness planner', agentTerminalId: 'agent-1', sourceSection: '../outside/secret.md#secret' });
    add({ sourceKind: 'doc', sourceRef: 'docs/link.md' });
    for (const seq of ['N1', 'N2']) expect((await get(seq).expect(403)).body, seq).toEqual({ error: 'The file is outside the project' });
  });
});
