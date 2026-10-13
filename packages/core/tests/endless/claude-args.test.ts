import { describe, it, expect } from 'vitest';
import { endlessClaudeArgs, TURN_MODEL, SUMMARY_MODEL, SUMMARY_EFFORT, FIXED_CONTEXT_ARGS, FIXED_CONTEXT_ENV, COMPACTION_ENV, COMPACTION_ISOLATION_ARGS } from '../../src/endless/claude-args.js';

const withoutModel = (args: string[]) => {
  const out: string[] = [];
  for (let k = 0; k < args.length; k++) {
    if (args[k] === '--model' || args[k] === '--effort') { k++; continue; }
    out.push(args[k]);
  }
  return out;
};

describe('endlessClaudeArgs', () => {
  const turn = endlessClaudeArgs({ model: TURN_MODEL, systemPrompt: 'SYS', mcpConfigPath: '/c/memory.mcp.json', userTools: true });
  const compaction = endlessClaudeArgs({ model: SUMMARY_MODEL, effort: SUMMARY_EFFORT, systemPrompt: 'SYS', mcpConfigPath: '/c/memory.mcp.json', userTools: false });

  it('turns keep the user MCP servers and skills; compactions are isolated', () => {
    expect(COMPACTION_ISOLATION_ARGS.length).toBeGreaterThan(0);
    for (const a of COMPACTION_ISOLATION_ARGS.filter(x => x.startsWith('--'))) {
      expect(turn).not.toContain(a);
      expect(compaction).toContain(a);
    }
  });
  it('apart from isolation, model and effort, turns and compactions match (same system prompt)', () => {
    const strip = (args: string[]) => withoutModel(args).filter((x, k, all) =>
      !COMPACTION_ISOLATION_ARGS.includes(x) && !(all[k - 1] === '--setting-sources'));
    expect(strip(turn)).toEqual(strip(compaction));
  });
  it('replaces the system prompt and never resumes', () => {
    expect(turn[turn.indexOf('--system-prompt') + 1]).toBe('SYS');
    expect(turn).not.toContain('--append-system-prompt');
    expect(turn).not.toContain('-r');
    expect(turn).toContain('--mcp-config');
  });
  it('uses opus for turns and haiku for summaries', () => {
    expect(turn[turn.indexOf('--model') + 1]).toBe('opus');
    expect(compaction[compaction.indexOf('--model') + 1]).toBe('haiku');
  });
  it('compaction env is the fixed env plus bundled skills off', () => {
    expect(COMPACTION_ENV).toEqual({ ...FIXED_CONTEXT_ENV, CLAUDE_CODE_DISABLE_BUNDLED_SKILLS: '1' });
    expect(FIXED_CONTEXT_ENV).not.toHaveProperty('CLAUDE_CODE_DISABLE_BUNDLED_SKILLS');
  });
  it('uses high effort for summaries', () => {
    expect(SUMMARY_EFFORT).toBe('high');
  });
  it('ends with the fixed-context switches', () => {
    expect(turn.slice(-FIXED_CONTEXT_ARGS.length)).toEqual([...FIXED_CONTEXT_ARGS]);
  });
});
