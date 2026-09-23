import { describe, expect, it } from 'vitest';
import { adaptForPolicy } from './policy-adapter.js';

describe('adaptForPolicy', () => {
  it('passes claude-code approvals through unchanged (identity)', () => {
    const pending = { toolName: 'Bash', input: { command: 'ls -la' } };
    expect(adaptForPolicy('claude-code', pending)).toEqual(pending);

    const filePending = { toolName: 'Write', input: { file_path: '/repo/src/a.ts' } };
    expect(adaptForPolicy('claude-code', filePending)).toEqual(filePending);
  });

  it('maps codex Shell approvals to Bash with the command preserved', () => {
    const pending = { toolName: 'Shell', input: { command: 'rm -rf /tmp/x', cwd: '/repo', reason: 'cleanup' } };
    expect(adaptForPolicy('codex', pending)).toEqual({ toolName: 'Bash', input: { command: 'rm -rf /tmp/x' } });
  });

  it('maps codex ApplyPatch approvals to Write with file_path and all change paths present', () => {
    const pending = {
      toolName: 'ApplyPatch',
      input: {
        file_path: 'src/a.ts',
        reason: 'refactor',
        changes: [
          { path: 'src/a.ts', kind: 'update', diff: '...' },
          { path: 'src/b.ts', kind: 'update', diff: '...' },
        ],
      },
    };
    expect(adaptForPolicy('codex', pending)).toEqual({
      toolName: 'Write',
      input: {
        file_path: 'src/a.ts',
        changes: [{ path: 'src/a.ts' }, { path: 'src/b.ts' }],
      },
    });
  });

  it('passes through other codex tool names unchanged (identity)', () => {
    const pending = { toolName: 'SomethingElse', input: { foo: 'bar' } };
    expect(adaptForPolicy('codex', pending)).toEqual(pending);
  });

  it('stubs grok/opencode (ACP) as identity, not yet wired', () => {
    const pending = { toolName: 'fs_write', input: { kind: 'edit', title: 'x', rawInput: {}, locations: [] } };
    expect(adaptForPolicy('grok', pending)).toEqual(pending);
    expect(adaptForPolicy('opencode', pending)).toEqual(pending);
  });

  it('stubs an unknown harness as identity', () => {
    const pending = { toolName: 'Whatever', input: { a: 1 } };
    expect(adaptForPolicy('some-future-harness', pending)).toEqual(pending);
  });

  it('carries an ApplyPatch move/rename destination through to the Write paths (M2)', () => {
    const pending = {
      toolName: 'ApplyPatch',
      input: { changes: [{ path: '/home/u/.codex/a.md', dest: '/repo/src/x.ts', kind: 'update' }] },
    };
    const out = adaptForPolicy('codex', pending);
    const changes = (out.input as { changes: Array<{ path?: string; dest?: string }> }).changes;
    const endpoints = changes.flatMap((c) => [c.path, c.dest]).filter(Boolean);
    expect(endpoints).toContain('/repo/src/x.ts');
    expect(endpoints).toContain('/home/u/.codex/a.md');
  });
});
