import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { buildHooksJson, writeGrokPlugin } from '../../src/providers/grok-plugin.js';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-plugin-')); });
afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

const read = (p: string) => JSON.parse(fs.readFileSync(path.join(dir, p), 'utf-8'));

describe('buildHooksJson', () => {
  const json = () => buildHooksJson('http://127.0.0.1:3456/api/events/grok/t1', '/opt/h.mjs', '/usr/bin/node') as {
    hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ type: string; command: string }> }>>;
  };

  it('reports turn-complete, which is what moves a thread out of working', () => {
    expect(json().hooks.Stop).toBeTruthy();
  });

  it('covers the same lifecycle set the Claude provider reports', () => {
    const keys = Object.keys(json().hooks).sort();
    expect(keys).toEqual(
      ['Notification', 'PostToolUse', 'PreToolUse', 'SessionEnd', 'SessionStart', 'Stop', 'UserPromptSubmit'].sort(),
    );
  });

  it('uses a command hook, which is the type Grok documents', () => {
    expect(json().hooks.Stop[0].hooks[0].type).toBe('command');
  });

  it('runs the helper with the events url', () => {
    const cmd = json().hooks.Stop[0].hooks[0].command;
    expect(cmd).toContain('/opt/h.mjs');
    expect(cmd).toContain('http://127.0.0.1:3456/api/events/grok/t1');
    expect(cmd.startsWith("'/usr/bin/node'")).toBe(true);
  });

  it('matches every tool on the tool events, and nothing on the rest', () => {
    expect(json().hooks.PreToolUse[0].matcher).toBe('*');
    expect(json().hooks.Stop[0].matcher).toBeUndefined();
  });

  it('quotes paths so a space cannot split the command', () => {
    const cmd = (buildHooksJson('http://x/y', '/Applications/My App/h.mjs', '/usr/bin/node') as never as {
      hooks: { Stop: Array<{ hooks: Array<{ command: string }> }> };
    }).hooks.Stop[0].hooks[0].command;
    expect(cmd).toContain("'/Applications/My App/h.mjs'");
  });
});

describe('writeGrokPlugin', () => {
  it('writes MCP servers where Grok reads them', () => {
    writeGrokPlugin({ dir, mcpServers: { doppler: { command: 'node', args: ['/opt/doppler.js'] } } });
    expect(read('.mcp.json')).toEqual({ mcpServers: { doppler: { command: 'node', args: ['/opt/doppler.js'] } } });
  });

  it('writes hooks where Grok reads them', () => {
    writeGrokPlugin({ dir, eventsUrl: 'http://x/events', hookHelperPath: '/opt/h.mjs', nodePath: '/usr/bin/node' });
    const hooks = read('hooks/hooks.json') as { hooks: Record<string, unknown> };
    expect(hooks.hooks.Stop).toBeTruthy();
  });

  it('writes both from one call, which is the point of the plugin dir', () => {
    const out = writeGrokPlugin({
      dir,
      mcpServers: { agency: { command: 'node', args: ['/opt/agency.js'] } },
      eventsUrl: 'http://x/events', hookHelperPath: '/opt/h.mjs', nodePath: '/usr/bin/node',
    });
    expect(out).toBe(dir);
    expect(fs.existsSync(path.join(dir, '.mcp.json'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'hooks', 'hooks.json'))).toBe(true);
  });

  it('returns null and writes nothing when there is nothing to inject', () => {
    expect(writeGrokPlugin({ dir: path.join(dir, 'unused') })).toBeNull();
    expect(fs.existsSync(path.join(dir, 'unused'))).toBe(false);
  });

  it('clears a previous spawn\'s MCP servers rather than leaving them injected', () => {
    writeGrokPlugin({ dir, mcpServers: { doppler: { command: 'node' } } });
    expect(fs.existsSync(path.join(dir, '.mcp.json'))).toBe(true);

    // Secrets disconnected: this spawn has no servers, only hooks.
    writeGrokPlugin({ dir, eventsUrl: 'http://x/e', hookHelperPath: '/opt/h.mjs' });
    expect(fs.existsSync(path.join(dir, '.mcp.json'))).toBe(false);
  });

  it('clears previous hooks when a spawn asks for none', () => {
    writeGrokPlugin({ dir, eventsUrl: 'http://x/e', hookHelperPath: '/opt/h.mjs' });
    expect(fs.existsSync(path.join(dir, 'hooks', 'hooks.json'))).toBe(true);

    writeGrokPlugin({ dir, mcpServers: { doppler: { command: 'node' } } });
    expect(fs.existsSync(path.join(dir, 'hooks', 'hooks.json'))).toBe(false);
  });

  it('is safe to call repeatedly on the same directory', () => {
    const spec = { dir, mcpServers: { a: { command: 'node' } }, eventsUrl: 'http://x/e', hookHelperPath: '/opt/h.mjs' };
    writeGrokPlugin(spec);
    expect(() => writeGrokPlugin(spec)).not.toThrow();
    expect(read('.mcp.json').mcpServers.a).toEqual({ command: 'node' });
  });
});
