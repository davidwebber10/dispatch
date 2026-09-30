import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import { IntegrationsService } from '../../src/integrations/service.js';
import { decodeLaunchSpec } from '../../src/integrations/launcher.js';
import type { McpServerSpec } from '../../src/mcp/injection.js';

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

  it('getServerSpecs keeps a ${VAR} stdio env as-is without a launcher', () => {
    s.add({ type: 'stdio', name: 'gh', command: 'npx', args: ['-y', 'gh-mcp'], env: { GITHUB_TOKEN: '${GH_PAT}' } });
    expect(s.getServerSpecs()).toEqual([{ name: 'gh', command: 'npx', args: ['-y', 'gh-mcp'], env: { GITHUB_TOKEN: '${GH_PAT}' } }]);
  });

  it('getServerSpecs skips disabled rows', () => {
    const i = s.add({ type: 'stdio', name: 'fs', command: 'x' });
    s.setEnabled(i.id, false);
    expect(s.getServerSpecs()).toEqual([]);
  });

  describe('with a launcher configured', () => {
    const launcher = { nodePath: '/usr/bin/node', launcherPath: '/app/dist/integrations/launcher.js', secretsDir: '/home/u/.dispatch' };
    let l: IntegrationsService;
    beforeEach(() => { const d = new Database(':memory:'); initSchema(d); l = new IntegrationsService(d, launcher); });

    /** The launcher argv shape, with the spec decoded back to its templates. */
    function unwrap(spec: McpServerSpec) {
      expect(spec.command).toBe(launcher.nodePath);
      expect(spec.args.slice(0, 4)).toEqual([launcher.launcherPath, '--secrets-dir', launcher.secretsDir, '--spec']);
      expect(spec.args).toHaveLength(5);
      return decodeLaunchSpec(spec.args[4]);
    }

    it('wraps a remote integration with a header ref; no ${...} left for a CLI to expand', () => {
      l.add({ type: 'remote', name: 'linear', url: 'https://mcp.linear.app/sse', headers: { Authorization: 'Bearer ${LINEAR_TOKEN}' } });
      const [spec] = l.getServerSpecs();
      expect(spec.name).toBe('linear');
      expect(spec.env).toBeUndefined();
      expect(spec.args.join(' ')).not.toContain('${');
      expect(unwrap(spec)).toEqual({ name: 'linear', type: 'remote', url: 'https://mcp.linear.app/sse', headers: { Authorization: 'Bearer ${LINEAR_TOKEN}' }, env: {} });
    });

    it('wraps a stdio integration with an env ref; the spec moves its env templates into the launcher', () => {
      l.add({ type: 'stdio', name: 'gh', command: 'npx', args: ['-y', 'gh-mcp'], env: { GITHUB_TOKEN: '${GH_PAT}', ROOT: '/tmp' } });
      const [spec] = l.getServerSpecs();
      expect(spec.env).toBeUndefined();
      expect(unwrap(spec)).toEqual({ name: 'gh', type: 'stdio', command: 'npx', args: ['-y', 'gh-mcp'], env: { GITHUB_TOKEN: '${GH_PAT}', ROOT: '/tmp' } });
    });

    it('keeps today\'s exact spec for integrations without refs', () => {
      l.add({ type: 'stdio', name: 'fs', command: 'npx', args: ['-y', 'server-fs'], env: { ROOT: '/tmp' } });
      l.add({ type: 'remote', name: 'open', url: 'https://mcp.example.com/sse', headers: { 'X-Team': 'eng' } });
      expect(l.getServerSpecs()).toEqual([
        { name: 'fs', command: 'npx', args: ['-y', 'server-fs'], env: { ROOT: '/tmp' } },
        { name: 'open', command: 'npx', args: ['-y', 'mcp-remote', 'https://mcp.example.com/sse', '--header', 'X-Team:eng'] },
      ]);
    });

    it('does not wrap for a ${VAR} in args or url alone (those are never resolved)', () => {
      l.add({ type: 'stdio', name: 'argref', command: 'npx', args: ['--token', '${IN_ARGS}'] });
      expect(l.getServerSpecs()).toEqual([{ name: 'argref', command: 'npx', args: ['--token', '${IN_ARGS}'] }]);
    });
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
