import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { agentSummaryHookPath, installAgentSummaryHook, withAgentSummaryPreload } from './claude-agent-summary.js';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-summary-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('the agent_summary preload', () => {
  it('writes the vendored hook into the data dir', () => {
    const hook = installAgentSummaryHook(dir);
    expect(hook).toBe(agentSummaryHookPath(dir));
    expect(fs.readFileSync(hook!, 'utf8')).toContain('[AgentSummary] Timer fired');
  });

  it('runs unhooked when the hook cannot be written', () => {
    expect(installAgentSummaryHook(dir, path.join(dir, 'missing.js'))).toBeNull();
  });

  // The space form (`--preload <path>`) makes `bun install` read the path as its script.
  it('adds one --preload= flag and keeps what was already there', () => {
    expect(withAgentSummaryPreload(undefined, '/d/hook.js')).toBe('--preload=/d/hook.js');
    expect(withAgentSummaryPreload('--smol', '/d/hook.js')).toBe('--smol --preload=/d/hook.js');
    expect(withAgentSummaryPreload('--smol --preload=/d/hook.js', '/d/hook.js')).toBe('--smol --preload=/d/hook.js');
    expect(withAgentSummaryPreload('--smol', null)).toBe('--smol');
    expect(withAgentSummaryPreload(undefined, null)).toBeUndefined();
  });
});
