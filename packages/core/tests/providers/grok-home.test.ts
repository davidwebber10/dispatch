import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { buildHooksJson, writeGrokHome } from '../../src/providers/grok-home.js';

let dir: string;
let realHome: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-home-'));
  realHome = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-real-'));
  fs.writeFileSync(path.join(realHome, 'auth.json'), '{"token":"x"}');
  fs.writeFileSync(path.join(realHome, 'config.toml'), '[ui]\n');
  fs.mkdirSync(path.join(realHome, 'sessions'), { recursive: true });
});
afterEach(() => {
  for (const d of [dir, realHome]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
});

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

describe('writeGrokHome', () => {
  it('writes MCP servers where Grok reads them', () => {
    writeGrokHome({ dir, realHome, mcpServers: { doppler: { command: 'node', args: ['/opt/doppler.js'] } } });
    expect(read('plugins/dispatch/.mcp.json')).toEqual({ mcpServers: { doppler: { command: 'node', args: ['/opt/doppler.js'] } } });
  });

  it('writes hooks where Grok reads them', () => {
    writeGrokHome({ dir, realHome, eventsUrl: 'http://x/events', hookHelperPath: '/opt/h.mjs', nodePath: '/usr/bin/node' });
    const hooks = read('plugins/dispatch/hooks/hooks.json') as { hooks: Record<string, unknown> };
    expect(hooks.hooks.Stop).toBeTruthy();
  });

  it('writes both from one call, which is the point of the per-thread home', () => {
    const out = writeGrokHome({
      dir,
      mcpServers: { agency: { command: 'node', args: ['/opt/agency.js'] } },
      eventsUrl: 'http://x/events', hookHelperPath: '/opt/h.mjs', nodePath: '/usr/bin/node',
    });
    expect(out).toBe(dir);
    expect(fs.existsSync(path.join(dir, 'plugins', 'dispatch', '.mcp.json'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'plugins', 'dispatch', 'hooks', 'hooks.json'))).toBe(true);
  });

  it('returns null and writes nothing when there is nothing to inject', () => {
    expect(writeGrokHome({ dir: path.join(dir, 'unused'), realHome })).toBeNull();
    expect(fs.existsSync(path.join(dir, 'unused'))).toBe(false);
  });

  it('clears a previous spawn\'s MCP servers rather than leaving them injected', () => {
    writeGrokHome({ dir, realHome, mcpServers: { doppler: { command: 'node' } } });
    expect(fs.existsSync(path.join(dir, 'plugins', 'dispatch', '.mcp.json'))).toBe(true);

    // Secrets disconnected: this spawn has no servers, only hooks.
    writeGrokHome({ dir, realHome, eventsUrl: 'http://x/e', hookHelperPath: '/opt/h.mjs' });
    expect(fs.existsSync(path.join(dir, 'plugins', 'dispatch', '.mcp.json'))).toBe(false);
  });

  it('clears previous hooks when a spawn asks for none', () => {
    writeGrokHome({ dir, realHome, eventsUrl: 'http://x/e', hookHelperPath: '/opt/h.mjs' });
    expect(fs.existsSync(path.join(dir, 'plugins', 'dispatch', 'hooks', 'hooks.json'))).toBe(true);

    writeGrokHome({ dir, realHome, mcpServers: { doppler: { command: 'node' } } });
    expect(fs.existsSync(path.join(dir, 'plugins', 'dispatch', 'hooks', 'hooks.json'))).toBe(false);
  });

  it('is safe to call repeatedly on the same directory', () => {
    const spec = { dir, realHome, mcpServers: { a: { command: 'node' } }, eventsUrl: 'http://x/e', hookHelperPath: '/opt/h.mjs' };
    writeGrokHome(spec);
    expect(() => writeGrokHome(spec)).not.toThrow();
    expect(read('plugins/dispatch/.mcp.json').mcpServers.a).toEqual({ command: 'node' });
  });
});

describe('the per-thread home shares everything except plugins', () => {
  it('links the credentials through, so the thread is still signed in', () => {
    writeGrokHome({ dir, realHome, eventsUrl: 'http://x/e', hookHelperPath: '/opt/h.mjs' });
    const link = path.join(dir, 'auth.json');
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(link, 'utf-8')).toBe('{"token":"x"}');
  });

  it('links config and sessions, so user settings apply and a session id still resolves', () => {
    writeGrokHome({ dir, realHome, eventsUrl: 'http://x/e', hookHelperPath: '/opt/h.mjs' });
    expect(fs.lstatSync(path.join(dir, 'config.toml')).isSymbolicLink()).toBe(true);
    expect(fs.lstatSync(path.join(dir, 'sessions')).isSymbolicLink()).toBe(true);
  });

  it('keeps plugins REAL and per-thread — the one thing that must not be shared', () => {
    // Sharing plugins would make every thread load every other thread's hooks and report
    // status for the wrong terminal.
    writeGrokHome({ dir, realHome, eventsUrl: 'http://x/e', hookHelperPath: '/opt/h.mjs' });
    const plugins = path.join(dir, 'plugins');
    expect(fs.lstatSync(plugins).isSymbolicLink()).toBe(false);
    expect(fs.existsSync(path.join(plugins, 'dispatch', 'hooks', 'hooks.json'))).toBe(true);
  });

  it('picks up a file the real home gained since the last spawn', () => {
    writeGrokHome({ dir, realHome, eventsUrl: 'http://x/e', hookHelperPath: '/opt/h.mjs' });
    fs.writeFileSync(path.join(realHome, 'models_cache.json'), '{}');
    writeGrokHome({ dir, realHome, eventsUrl: 'http://x/e', hookHelperPath: '/opt/h.mjs' });
    expect(fs.existsSync(path.join(dir, 'models_cache.json'))).toBe(true);
  });

  it('survives a real home that does not exist yet', () => {
    expect(() => writeGrokHome({
      dir, realHome: path.join(realHome, 'nope'), eventsUrl: 'http://x/e', hookHelperPath: '/opt/h.mjs',
    })).not.toThrow();
  });
});
