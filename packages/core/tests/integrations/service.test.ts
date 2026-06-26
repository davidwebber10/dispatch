import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import { IntegrationsService } from '../../src/integrations/service.js';

function svc() { const d = new Database(':memory:'); initSchema(d); return new IntegrationsService(d); }

describe('IntegrationsService', () => {
  let s: IntegrationsService;
  beforeEach(() => { s = svc(); });

  it('adds a remote integration and lists it', () => {
    const i = s.add({ type: 'remote', name: 'linear', url: 'https://mcp.linear.app/sse' });
    expect(i.name).toBe('linear');
    expect(s.list().map((x) => x.name)).toEqual(['linear']);
  });

  it('rejects invalid names and bad input via validate()', () => {
    expect(IntegrationsService.validate({ type: 'remote', name: 'has space', url: 'https://x' })).toMatch(/name/);
    expect(IntegrationsService.validate({ type: 'remote', name: 'ok', url: 'not-a-url' })).toMatch(/url/);
    expect(IntegrationsService.validate({ type: 'stdio', name: 'ok' })).toMatch(/command/);
    expect(IntegrationsService.validate({ type: 'remote', name: 'ok', url: 'https://x' })).toBeNull();
  });

  it('rejects a duplicate name (case-insensitive)', () => {
    s.add({ type: 'stdio', name: 'fs', command: 'x' });
    expect(() => s.add({ type: 'stdio', name: 'FS', command: 'y' })).toThrow(/exists/);
  });

  it('getServerSpecs resolves stdio directly', () => {
    s.add({ type: 'stdio', name: 'fs', command: 'npx', args: ['-y', 'server-fs'], env: { ROOT: '/tmp' } });
    expect(s.getServerSpecs()).toEqual([{ name: 'fs', command: 'npx', args: ['-y', 'server-fs'], env: { ROOT: '/tmp' } }]);
  });

  it('getServerSpecs wraps remote via mcp-remote with header args (secrets stay as ${VAR})', () => {
    s.add({ type: 'remote', name: 'linear', url: 'https://mcp.linear.app/sse', headers: { Authorization: '${LINEAR}' } });
    expect(s.getServerSpecs()).toEqual([{ name: 'linear', command: 'npx', args: ['-y', 'mcp-remote', 'https://mcp.linear.app/sse', '--header', 'Authorization:${LINEAR}'] }]);
  });

  it('getServerSpecs skips disabled rows', () => {
    const i = s.add({ type: 'stdio', name: 'fs', command: 'x' });
    s.setEnabled(i.id, false);
    expect(s.getServerSpecs()).toEqual([]);
  });

  it('export omits id/timestamps; import replays and skips existing names', () => {
    s.add({ type: 'remote', name: 'linear', url: 'https://mcp.linear.app/sse' });
    const doc = s.export();
    expect(doc.version).toBe(1);
    expect(doc.integrations[0]).not.toHaveProperty('id');
    const s2 = svc();
    expect(s2.import(doc)).toEqual({ added: ['linear'], skipped: [] });
    // re-import into the same store skips the existing name
    expect(s2.import(doc)).toEqual({ added: [], skipped: ['linear'] });
  });
});
