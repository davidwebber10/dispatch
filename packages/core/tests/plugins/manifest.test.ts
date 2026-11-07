import { describe, it, expect } from 'vitest';
import { parseManifest, satisfiesDispatch, PLUGIN_ID_RE } from '../../src/plugins/manifest.js';

describe('parseManifest', () => {
  const good = JSON.stringify({ id: 'daily-rundown', name: 'Daily rundown', version: '0.1.0', web: 'web.js', permissions: ['read:threads'] });

  it('accepts a minimal manifest', () => {
    expect(parseManifest(good, 'daily-rundown')).toEqual({ ok: true, manifest: expect.objectContaining({ id: 'daily-rundown', web: 'web.js', permissions: ['read:threads'] }) });
  });

  it('refuses invalid JSON with the parse error', () => {
    const r = parseManifest('{ nope', 'x');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/JSON/);
  });

  it('refuses an id that does not match the folder', () => {
    expect(parseManifest(good, 'other')).toEqual({ ok: false, error: 'plugin.json id "daily-rundown" does not match the folder "other"' });
  });

  it('refuses a missing name or version, and a web path that leaves the folder', () => {
    expect(parseManifest(JSON.stringify({ id: 'a', version: '1' }), 'a').ok).toBe(false);
    expect(parseManifest(JSON.stringify({ id: 'a', name: 'A' }), 'a').ok).toBe(false);
    expect(parseManifest(JSON.stringify({ id: 'a', name: 'A', version: '1', web: '../x.js' }), 'a')).toEqual({ ok: false, error: 'plugin.json "web" must be a file inside the plugin folder' });
    expect(parseManifest(JSON.stringify({ id: 'a', name: 'A', version: '1', web: '/etc/passwd' }), 'a').ok).toBe(false);
    expect(parseManifest(JSON.stringify({ id: 'a', name: 'A', version: '1', web: 'dist/web.js' }), 'a').ok).toBe(true);
  });

  it('refuses a manifest that is not an object', () => {
    expect(parseManifest('[]', 'a').ok).toBe(false);
    expect(parseManifest('"x"', 'a').ok).toBe(false);
  });

  it('PLUGIN_ID_RE: lowercase, digits, dashes, up to 64', () => {
    expect(PLUGIN_ID_RE.test('a-1')).toBe(true);
    expect(PLUGIN_ID_RE.test('-a')).toBe(false);
    expect(PLUGIN_ID_RE.test('A')).toBe(false);
    expect(PLUGIN_ID_RE.test('a'.repeat(64))).toBe(true);
    expect(PLUGIN_ID_RE.test('a'.repeat(65))).toBe(false);
  });
});

describe('satisfiesDispatch', () => {
  it('compares the running version against a >= range', () => {
    expect(satisfiesDispatch('>=3.28', '3.28.0')).toBe(true);
    expect(satisfiesDispatch('>=3.28', '3.27.9')).toBe(false);
    expect(satisfiesDispatch('>=3.28.1', '3.28.0')).toBe(false);
    expect(satisfiesDispatch('>=3.28.1', '3.28.1')).toBe(true);
    expect(satisfiesDispatch('>=3.28', '4.0.0')).toBe(true);
    expect(satisfiesDispatch(undefined, '1.0.0')).toBe(true);
    expect(satisfiesDispatch('nonsense', '1.0.0')).toBe(false);
  });

  it('worker: command, args, env and jobs parse; a job without id or cron, a bad cron, or a command that is not a string is an error', () => {
    const ok = parseManifest(JSON.stringify({ id: 'p', name: 'P', version: '1.0.0', worker: { command: 'node', args: ['worker/index.js'], env: { A: '1', B: 2 }, jobs: [{ id: 'morning', cron: '0 7 * * 1-5' }] } }), 'p');
    expect(ok).toMatchObject({ ok: true, manifest: { worker: { command: 'node', args: ['worker/index.js'], env: { A: '1' }, jobs: [{ id: 'morning', cron: '0 7 * * 1-5' }] } } });
    const bare = parseManifest(JSON.stringify({ id: 'p', name: 'P', version: '1.0.0', worker: { command: 'node' } }), 'p');
    expect(bare).toMatchObject({ ok: true, manifest: { worker: { command: 'node', args: [], env: {}, jobs: [] } } });
    const err = (m: Record<string, unknown>) => { const r = parseManifest(JSON.stringify({ id: 'p', name: 'P', version: '1.0.0', ...m }), 'p'); return r.ok ? null : r.error; };
    expect(err({ worker: 'node' })).toMatch(/"worker" must be an object/);
    expect(err({ worker: { command: 3 } })).toMatch(/"worker" needs a command/);
    expect(err({ worker: { command: 'node', jobs: [{ cron: '* * * * *' }] } })).toMatch(/"worker.jobs\[0\]" needs an id and a cron/);
    expect(err({ worker: { command: 'node', jobs: [{ id: 'x', cron: 'every day' }] } })).toMatch(/"worker.jobs\[0\].cron" is not a cron expression/);
    expect(err({ worker: { command: 'node', jobs: [{ id: 'x', cron: '* * * * *' }, { id: 'x', cron: '0 * * * *' }] } })).toMatch(/"worker.jobs" has the id "x" twice/);
  });
});
