import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  COORDINATOR_DISALLOWED_TOOLS,
  coordinatorMemoryDirFor,
  coordinatorToolPolicy,
  makeCoordinatorPolicy,
} from './coordinator-policy.js';

const memoryFile = path.join(os.homedir(), '.claude', 'projects', '-x', 'memory', 'MEMORY.md');

describe('coordinatorToolPolicy', () => {
  it('allows read-only tools unconditionally', () => {
    expect(coordinatorToolPolicy('Read', { file_path: '/repo/src/a.ts' })).toEqual({ allow: true });
    expect(coordinatorToolPolicy('Grep', { pattern: 'x' })).toEqual({ allow: true });
    expect(coordinatorToolPolicy('mcp__dispatch__spawn_agent', { agentType: 'implementer' })).toEqual({ allow: true });
  });

  it('allows file writes under ~/.claude (its own memory/plans)', () => {
    expect(coordinatorToolPolicy('Write', { file_path: memoryFile })).toEqual({ allow: true });
    expect(coordinatorToolPolicy('Edit', { file_path: memoryFile })).toEqual({ allow: true });
  });

  it('denies file writes anywhere else, with a delegate message', () => {
    const d = coordinatorToolPolicy('Edit', { file_path: '/Users/x/Developer/Projects/repo/src/app.ts' });
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.message).toContain('implementer');
    expect(coordinatorToolPolicy('Write', {}).allow).toBe(false); // no path → not provably safe
  });

  it('denies ship-shaped Bash commands', () => {
    for (const cmd of [
      'git commit -m "x"', 'git push origin main', 'cd /r && git merge feature',
      'gh pr merge 12', 'gh pr create --title x', 'gh workflow run deploy.yml -f environment=production',
      'gh release create v1', 'npm publish', 'pnpm publish', 'dispatch update', './bin/dispatch release 1.2.3',
      'terraform apply',
      'git -C ../other-repo commit -m x', 'git -c user.email=x push', 'gh -R owner/repo pr merge 1',
      'npm --workspace=pkg publish',
    ]) {
      expect(coordinatorToolPolicy('Bash', { command: cmd }).allow, cmd).toBe(false);
    }
  });

  it('allows read-only Bash', () => {
    for (const cmd of ['git status', 'git log --oneline -5', 'ls -la', 'rg -n pattern src/', 'gh pr checks 12', 'gh pr view 12']) {
      expect(coordinatorToolPolicy('Bash', { command: cmd }).allow, cmd).toBe(true);
    }
  });

  it('denies native subagents and points at spawn_agent', () => {
    const d = coordinatorToolPolicy('Agent', { prompt: 'go research' });
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.message).toContain('spawn_agent');
    expect(coordinatorToolPolicy('Task', {}).allow).toBe(false);
  });

  it('denies native Workflow orchestration — same class as a native subagent', () => {
    const d = coordinatorToolPolicy('Workflow', { script: 'export const meta = {}' });
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.message).toContain('spawn_agent');
  });

  it('exports the spawn-time disallow list matching the tools the policy denies', () => {
    expect(COORDINATOR_DISALLOWED_TOOLS).toEqual(['Agent', 'Task', 'Workflow']);
  });
});

describe('makeCoordinatorPolicy', () => {
  it('allows a Write under the given memory dir and denies one under ~/.claude', () => {
    const policy = makeCoordinatorPolicy('/home/x/.codex');
    expect(policy('Write', { file_path: '/home/x/.codex/projects/-x/memory/MEMORY.md' })).toEqual({ allow: true });
    const d = policy('Write', { file_path: memoryFile });
    expect(d.allow).toBe(false);
  });

  it('denies a mixed changes[] patch (one path outside the memory dir)', () => {
    const policy = makeCoordinatorPolicy('/home/x/.codex');
    const d = policy('Write', {
      changes: [{ path: '/home/x/.codex/memory/MEMORY.md' }, { path: '/repo/src/app.ts' }],
    });
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.message).toContain('/home/x/.codex');
  });

  it('allows a changes[] patch when every path is under the memory dir', () => {
    const policy = makeCoordinatorPolicy('/home/x/.codex');
    const d = policy('Write', {
      changes: [{ path: '/home/x/.codex/memory/MEMORY.md' }, { path: '/home/x/.codex/memory/other.md' }],
    });
    expect(d).toEqual({ allow: true });
  });

  it('denies a changes[] patch with no valid paths', () => {
    const policy = makeCoordinatorPolicy('/home/x/.codex');
    expect(policy('Write', { changes: [] }).allow).toBe(false);
  });

  it('leaves coordinatorToolPolicy default behavior unchanged (~/.claude)', () => {
    expect(coordinatorToolPolicy('Write', { file_path: memoryFile })).toEqual({ allow: true });
    const d = coordinatorToolPolicy('Write', { file_path: '/repo/src/app.ts' });
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.message).toContain('.claude');
  });

  it('denies a file_path that traverses out of the memory dir via ..', () => {
    const policy = makeCoordinatorPolicy('/home/x/.codex');
    // String-prefix check would pass this (it starts with '/home/x/.codex/'), but it resolves
    // to /home/x/etc/passwd — outside the memory dir.
    const d = policy('Write', { file_path: '/home/x/.codex/../../etc/passwd' });
    expect(d.allow).toBe(false);
  });

  it('denies a changes[] entry with a traversal path', () => {
    const policy = makeCoordinatorPolicy('/home/x/.codex');
    const d = policy('Write', {
      changes: [{ path: '/home/x/.codex/memory/MEMORY.md' }, { path: '/home/x/.codex/../../etc/passwd' }],
    });
    expect(d.allow).toBe(false);
  });

  it('allows a legitimate nested path under the memory dir', () => {
    const policy = makeCoordinatorPolicy('/home/x/.codex');
    expect(policy('Write', { file_path: '/home/x/.codex/sub/dir/file.md' })).toEqual({ allow: true });
  });

  it('denies a write targeting the memory dir root itself (not a real write target)', () => {
    const policy = makeCoordinatorPolicy('/home/x/.codex');
    expect(policy('Write', { file_path: '/home/x/.codex' }).allow).toBe(false);
  });
});

describe('coordinatorMemoryDirFor', () => {
  it('resolves the claude-code coordinator memory dir to ~/.claude', () => {
    expect(coordinatorMemoryDirFor('claude-code')).toBe(path.join(os.homedir(), '.claude'));
  });

  it('resolves the codex coordinator memory dir to ~/.codex', () => {
    expect(coordinatorMemoryDirFor('codex')).toBe(path.join(os.homedir(), '.codex'));
  });

  it('a codex coordinator policy allows a write under ~/.codex, denies one under ~/.claude, and denies a repo path', () => {
    const policy = makeCoordinatorPolicy(coordinatorMemoryDirFor('codex'));
    expect(policy('Write', { file_path: path.join(os.homedir(), '.codex', 'memory', 'MEMORY.md') })).toEqual({ allow: true });
    expect(policy('Write', { file_path: path.join(os.homedir(), '.claude', 'memory', 'MEMORY.md') }).allow).toBe(false);
    expect(policy('Edit', { file_path: '/Users/x/Developer/Projects/repo/src/app.ts' }).allow).toBe(false);
  });

  it('falls back to ~/.claude for an unrecognized harness', () => {
    expect(coordinatorMemoryDirFor('grok')).toBe(path.join(os.homedir(), '.claude'));
  });
});
