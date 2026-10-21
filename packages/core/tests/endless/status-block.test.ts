import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import * as sessionsDb from '../../src/db/sessions.js';
import * as terminalsDb from '../../src/db/terminals.js';
import { EndlessStore } from '../../src/endless/store.js';
import { collectProjects, buildStatusBlock, STATUS_MAX_BYTES, type ProjectStatus } from '../../src/endless/status-block.js';

const NOW = Date.UTC(2026, 9, 13, 14, 5, 9);

describe('status block', () => {
  it('collects live threads, threads that need the user, open items, and the last report', () => {
    const db = new Database(':memory:');
    initSchema(db);
    sessionsDb.create(db, { id: 's1', provider: 'claude-code', name: 'salsify', workingDir: '/work/salsify' });
    sessionsDb.create(db, { id: 's2', provider: 'claude-code', name: 'quiet', workingDir: '/work/quiet' });
    terminalsDb.create(db, { id: 't1', sessionId: 's1', type: 'claude-code', label: 'a' });
    terminalsDb.create(db, { id: 't2', sessionId: 's1', type: 'claude-code', label: 'b' });
    terminalsDb.updateStatus(db, 't1', 'working');
    terminalsDb.updateStatus(db, 't2', 'needs_input');
    db.prepare("INSERT INTO ledger_items (session_id, seq, kind, text, author, created_at, updated_at) VALUES ('s1', 1, 'decide', 'pick a db', 'overseer', 'x', 'x')").run();
    const store = new EndlessStore(db);
    store.append({ kind: 'work', text: '[Fixer] report: done', project: 's1' });
    const rows = collectProjects(db, store);
    expect(rows.find((r) => r.id === 's1')).toEqual({ id: 's1', name: 'salsify', folder: '/work/salsify', live: 1, needsYou: 1, openItems: 1, lastReport: '[Fixer] report: done', messages: 1 });
    expect(rows.find((r) => r.id === 's2')).toMatchObject({ live: 0, needsYou: 0, openItems: 0, lastReport: null, messages: 0 });
  });

  it('lists projects with activity plus the tagged project, after the date', () => {
    const projects: ProjectStatus[] = [
      { id: 's1', name: 'salsify', folder: '/work/salsify', live: 2, needsYou: 1, openItems: 3, lastReport: null, messages: 4 },
      { id: 's2', name: 'quiet', folder: '/work/quiet', live: 0, needsYou: 0, openItems: 0, lastReport: null, messages: 0 },
      { id: 's3', name: 'tagged', folder: '/work/tagged', live: 0, needsYou: 0, openItems: 0, lastReport: null, messages: 0 },
    ];
    expect(buildStatusBlock(projects, { now: NOW, timeZone: 'UTC', projectId: 's3' })).toBe([
      '<status>',
      'now: Tue 2026-10-13 14:05:09 UTC',
      '- tagged: 0 live, 0 need you, 0 open items; folder /work/tagged',
      '- salsify: 2 live, 1 need you, 3 open items; folder /work/salsify',
      '</status>',
    ].join('\n'));
  });

  it('stays within 2 KB', () => {
    const many: ProjectStatus[] = Array.from({ length: 80 }, (_, k) => ({ id: `s${k}`, name: `project-${k}`, folder: `/work/project-${k}`, live: 1, needsYou: 0, openItems: 2, lastReport: null, messages: 0 }));
    const block = buildStatusBlock(many, { now: NOW, timeZone: 'UTC', projectId: null });
    expect(Buffer.byteLength(block, 'utf8')).toBeLessThanOrEqual(STATUS_MAX_BYTES);
    expect(block).toMatch(/- … \d+ more projects\n<\/status>$/);
  });
});
