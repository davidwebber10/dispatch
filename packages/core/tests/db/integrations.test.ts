import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import * as integrationsDb from '../../src/db/integrations.js';

function db() { const d = new Database(':memory:'); initSchema(d); return d; }

describe('integrations db', () => {
  let d: Database.Database;
  beforeEach(() => { d = db(); });

  it('creates and reads a remote integration with JSON round-trips', () => {
    const created = integrationsDb.create(d, { id: 'i1', name: 'linear', type: 'remote', url: 'https://mcp.linear.app/sse', headers: { Authorization: '${LINEAR}' } });
    expect(created).toMatchObject({ id: 'i1', name: 'linear', type: 'remote', url: 'https://mcp.linear.app/sse', headers: { Authorization: '${LINEAR}' }, args: [], env: {}, enabled: true });
    const got = integrationsDb.getById(d, 'i1');
    expect(got).toEqual(created);
  });

  it('creates a stdio integration with args + env', () => {
    const created = integrationsDb.create(d, { id: 'i2', name: 'fs', type: 'stdio', command: 'npx', args: ['-y', 'server-fs'], env: { ROOT: '/tmp' } });
    expect(created).toMatchObject({ type: 'stdio', command: 'npx', args: ['-y', 'server-fs'], env: { ROOT: '/tmp' }, url: null, headers: {} });
  });

  it('lists in creation order and removes', () => {
    integrationsDb.create(d, { id: 'a', name: 'a', type: 'stdio', command: 'x' });
    integrationsDb.create(d, { id: 'b', name: 'b', type: 'stdio', command: 'y' });
    expect(integrationsDb.list(d).map((i) => i.id)).toEqual(['a', 'b']);
    integrationsDb.remove(d, 'a');
    expect(integrationsDb.list(d).map((i) => i.id)).toEqual(['b']);
  });

  it('toggles enabled and returns the updated row', () => {
    integrationsDb.create(d, { id: 'i', name: 'i', type: 'stdio', command: 'x' });
    expect(integrationsDb.setEnabled(d, 'i', false)?.enabled).toBe(false);
    expect(integrationsDb.getById(d, 'i')?.enabled).toBe(false);
    expect(integrationsDb.setEnabled(d, 'missing', false)).toBeNull();
  });
});
