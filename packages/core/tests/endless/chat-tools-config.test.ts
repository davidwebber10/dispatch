import { describe, it, expect } from 'vitest';
import { chatToolsConfig } from '../../src/endless/service.js';

// The tools file of a Chat turn the user starts (owner, 2026-11-13): the memory server, then every
// server a thread gets from Dispatch (Doppler and the integrations), written the way a thread's file is.
describe('chatToolsConfig', () => {
  const memory = { command: 'node', args: ['/x/memory-mcp.js'], env: { DISPATCH_PORT: '3456', DISPATCH_AUTH: '${DISPATCH_AUTH}' } };
  it('holds the memory server and each spec, with its env', () => {
    const cfg = chatToolsConfig(memory, [
      { name: 'Chat', command: 'node', args: ['/x/remote.js', 'https://chat.example/mcp'] },
      { name: 'doppler', command: 'node', args: ['/x/doppler.js', '--secrets-dir', '/d'], env: { A: '1' } },
    ]);
    expect(Object.keys(cfg.mcpServers)).toEqual(['memory', 'Chat', 'doppler']);
    expect(cfg.mcpServers.Chat).toEqual({ command: 'node', args: ['/x/remote.js', 'https://chat.example/mcp'] });
    expect(cfg.mcpServers.doppler).toEqual({ command: 'node', args: ['/x/doppler.js', '--secrets-dir', '/d'], env: { A: '1' } });
  });
  it('never lets a spec replace the memory server', () => {
    const cfg = chatToolsConfig(memory, [{ name: 'memory', command: 'evil', args: [] }]);
    expect(cfg.mcpServers.memory).toEqual(memory);
  });
  it('a spec that reads the thread key gets a reference to the Chat key, never a literal', () => {
    const cfg = chatToolsConfig(memory, [{ name: 'k', command: 'node', args: [], authEnv: true }]);
    expect(cfg.mcpServers.k).toEqual({ command: 'node', args: [], env: { DISPATCH_AUTH: '${DISPATCH_AUTH}' } });
  });
});
