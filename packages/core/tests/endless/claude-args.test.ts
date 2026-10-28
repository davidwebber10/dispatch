import { describe, it, expect } from 'vitest';
import { endlessClaudeArgs, TURN_MODEL, SUMMARY_MODEL, SUMMARY_EFFORT, FIXED_CONTEXT_ARGS, FIXED_CONTEXT_ENV, COMPACTION_ENV, COMPACTION_ISOLATION_ARGS, REPORT_TURN_DISALLOWED_TOOLS } from '../../src/endless/claude-args.js';

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

  describe('a turn that a thread report started', () => {
    const report = endlessClaudeArgs({ model: TURN_MODEL, systemPrompt: 'SYS', mcpConfigPath: '/c/memory.mcp.json', userTools: true, reportTurn: true });
    const disallowed = (args: string[]) => {
      const out: string[] = [];
      for (let k = args.indexOf('--disallowedTools') + 1; k > 0 && k < args.length && !args[k].startsWith('--'); k++) out.push(args[k]);
      return out;
    };

    it('has no shell tool', () => {
      expect(REPORT_TURN_DISALLOWED_TOOLS).toEqual(['Bash', 'BashOutput', 'KillShell']);
      for (const t of REPORT_TURN_DISALLOWED_TOOLS) expect(disallowed(report)).toContain(t);
    });
    it('loads only the Dispatch memory MCP server: no user server, no connector', () => {
      expect(report).toContain('--strict-mcp-config');
      expect(report[report.indexOf('--mcp-config') + 1]).toBe('/c/memory.mcp.json');
      expect(turn).not.toContain('--strict-mcp-config');
    });
    it('a user-started turn keeps the shell and the connectors', () => {
      for (const t of REPORT_TURN_DISALLOWED_TOOLS) expect(disallowed(turn)).not.toContain(t);
      expect(disallowed(turn)).toEqual(['AskUserQuestion']);
    });
    it('keeps the user settings, plugins and skills, and adds no permission prompt', () => {
      expect(report).not.toContain('--setting-sources');
      expect(report).not.toContain('--disable-slash-commands');
      expect(report[report.indexOf('--permission-mode') + 1]).toBe('default');
      expect(report).not.toContain('--allowedTools');
      expect(report).not.toContain('--tools');
    });
    it('still ends with the fixed-context switches, and keeps AskUserQuestion off', () => {
      expect(disallowed(report)).toContain('AskUserQuestion');
      expect(report[report.length - 1]).not.toMatch(/^--/);
    });
  });
});
