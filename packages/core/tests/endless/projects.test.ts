import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import * as sessionsDb from '../../src/db/sessions.js';
import * as terminalsDb from '../../src/db/terminals.js';
import { resolveProject, overseerOf } from '../../src/endless/projects.js';

const rows = [
  { id: 's1', name: 'salsify', working_dir: '/w/salsify' },
  { id: 's2', name: 'Dispatch', working_dir: '/w/dispatch' },
  { id: 's3', name: 'site', working_dir: '/w/site-a' },
  { id: 's4', name: 'Site', working_dir: '/w/site-b' },
];

describe('resolveProject', () => {
  it('finds a project by id, or by name without regard to case or outer spaces', () => {
    expect(resolveProject(rows, 's2')).toEqual({ ok: true, project: { id: 's2', name: 'Dispatch', folder: '/w/dispatch' } });
    expect(resolveProject(rows, '  dispatch ')).toEqual({ ok: true, project: { id: 's2', name: 'Dispatch', folder: '/w/dispatch' } });
  });
  it('names the known projects when the name is unknown', () => {
    expect(resolveProject(rows, 'salsfy')).toEqual({ ok: false, error: 'unknown project "salsfy". Known projects: salsify, Dispatch, site, Site' });
  });
  it('lists the ids when a name is ambiguous', () => {
    expect(resolveProject(rows, 'SITE')).toEqual({
      ok: false,
      error: '"SITE" names 2 projects: site (id s3, folder /w/site-a); Site (id s4, folder /w/site-b). Pass the id.',
    });
  });
  it('asks for a project when none is given', () => {
    expect(resolveProject(rows, '')).toEqual({ ok: false, error: 'project is required: a project name or id from the status block' });
    expect(resolveProject(rows, undefined)).toEqual({ ok: false, error: 'project is required: a project name or id from the status block' });
  });
});

describe('overseerOf', () => {
  it('finds the live Control Plane terminal of a project, or null', () => {
    const db = new Database(':memory:');
    initSchema(db);
    sessionsDb.create(db, { id: 's1', provider: 'claude-code', name: 'p', workingDir: '/tmp' });
    expect(overseerOf(db, 's1')).toBeNull();
    terminalsDb.create(db, { id: 'w', sessionId: 's1', type: 'claude-code', label: 'w', config: { role: 'agent' } });
    terminalsDb.create(db, { id: 'c', sessionId: 's1', type: 'claude-code', label: 'Control Plane', config: { role: 'coordinator' } });
    expect(overseerOf(db, 's1')).toBe('c');
    terminalsDb.archive(db, 'c');
    expect(overseerOf(db, 's1')).toBeNull();
  });
});
