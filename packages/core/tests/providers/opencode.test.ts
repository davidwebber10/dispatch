import { describe, it, expect, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { opencodeProvider, OPENCODE_DEFAULT_MODEL } from '../../src/providers/opencode.js';
import { writeOpencodeConfig } from '../../src/providers/opencode-config.js';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-opencode-'));
afterAll(() => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ } });

describe('opencodeProvider', () => {
  it('the structured command is bare `opencode acp` — everything else rides OPENCODE_CONFIG', () => {
    expect(opencodeProvider.buildStructuredCommand!({} as any)).toEqual({ command: 'opencode', args: ['acp'] });
  });

  it('is Pretty-only: the PTY builders throw instead of returning a TUI command', () => {
    expect(() => opencodeProvider.buildNewCommand({} as any)).toThrow(/Pretty-only/);
    expect(() => opencodeProvider.buildResumeCommand({} as any)).toThrow(/Pretty-only/);
    expect(() => opencodeProvider.buildRunnerCommand({} as any)).toThrow(/runner/);
  });
});

describe('writeOpencodeConfig', () => {
  it('writes model (curated default when none picked), autonomous permissions, and MCP servers', () => {
    const dir = path.join(tmpDir, 't1');
    const p = writeOpencodeConfig({
      dir,
      mcpServers: { dispatch: { command: 'node', args: ['agency.js'], env: { DISPATCH_TERMINAL_ID: 'x' } } },
    });
    const cfg = JSON.parse(fs.readFileSync(p, 'utf-8'));
    expect(cfg.model).toBe(OPENCODE_DEFAULT_MODEL);
    expect(cfg.permission).toEqual({ edit: 'allow', bash: 'allow', webfetch: 'allow' });
    expect(cfg.mcp.dispatch).toEqual({
      type: 'local',
      command: ['node', 'agency.js'],
      enabled: true,
      environment: { DISPATCH_TERMINAL_ID: 'x' },
    });
    expect(cfg.instructions).toBeUndefined(); // no prompt → no rules file reference
  });

  it('a supervised thread asks for permission; the system prompt lands in rules.md', () => {
    const dir = path.join(tmpDir, 't2');
    const p = writeOpencodeConfig({ dir, model: 'openrouter/moonshotai/kimi-k3', escalate: true, systemPrompt: 'Use Doppler for secrets.' });
    const cfg = JSON.parse(fs.readFileSync(p, 'utf-8'));
    expect(cfg.model).toBe('openrouter/moonshotai/kimi-k3');
    expect(cfg.permission.bash).toBe('ask');
    expect(cfg.instructions).toHaveLength(1);
    expect(fs.readFileSync(cfg.instructions[0], 'utf-8')).toBe('Use Doppler for secrets.');
  });

  it('a respawn without a prompt removes the stale rules.md from the previous spawn', () => {
    const dir = path.join(tmpDir, 't3');
    writeOpencodeConfig({ dir, systemPrompt: 'old rules' });
    const p = writeOpencodeConfig({ dir });
    const cfg = JSON.parse(fs.readFileSync(p, 'utf-8'));
    expect(cfg.instructions).toBeUndefined();
    expect(fs.existsSync(path.join(dir, 'rules.md'))).toBe(false);
  });
});
