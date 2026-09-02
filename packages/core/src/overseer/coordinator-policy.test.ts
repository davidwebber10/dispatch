import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { coordinatorToolPolicy } from './coordinator-policy.js';

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
});
