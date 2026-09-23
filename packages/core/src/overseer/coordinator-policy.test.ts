import fs from 'node:fs';
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

  it('denies Bash when command is not a non-empty string (fail closed, not coerce-to-empty-allow)', () => {
    expect(coordinatorToolPolicy('Bash', { command: undefined }).allow).toBe(false);
    expect(coordinatorToolPolicy('Bash', { command: 42 }).allow).toBe(false);
    expect(coordinatorToolPolicy('Bash', { command: '' }).allow).toBe(false);
    expect(coordinatorToolPolicy('Bash', {}).allow).toBe(false);
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

  it('resolves the codex coordinator memory dir to a DEDICATED subdir, not the whole Codex home', () => {
    expect(coordinatorMemoryDirFor('codex')).toBe(path.join(os.homedir(), '.codex', 'dispatch-coordinator'));
  });

  it('a codex coordinator policy allows a write under its memory subdir, denies one under ~/.claude, and denies a repo path', () => {
    const policy = makeCoordinatorPolicy(coordinatorMemoryDirFor('codex'));
    expect(policy('Write', { file_path: path.join(os.homedir(), '.codex', 'dispatch-coordinator', 'MEMORY.md') })).toEqual({ allow: true });
    expect(policy('Write', { file_path: path.join(os.homedir(), '.claude', 'memory', 'MEMORY.md') }).allow).toBe(false);
    expect(policy('Edit', { file_path: '/Users/x/Developer/Projects/repo/src/app.ts' }).allow).toBe(false);
  });

  // N1: the Codex home holds the CLI's OWN config — config.toml (notify / mcp_servers run
  // commands outside the sandbox), rules/*.rules (execpolicy allow rules), the global AGENTS.md
  // every Codex thread loads, skills, and real git worktrees. None of it is coordinator memory.
  it('a codex coordinator policy denies writes to the Codex CLI config, rules, instructions, skills, and worktrees (N1)', () => {
    const policy = makeCoordinatorPolicy(coordinatorMemoryDirFor('codex'), { commandsEscalate: true });
    const codexHome = path.join(os.homedir(), '.codex');
    for (const rel of ['config.toml', 'rules/default.rules', 'AGENTS.md', 'skills/x/SKILL.md', 'worktrees/744c/repo/README.md', 'auth.json']) {
      expect(policy('Write', { changes: [{ path: path.join(codexHome, rel) }] }).allow, rel).toBe(false);
    }
  });

  it('falls back to ~/.claude for an unrecognized harness', () => {
    expect(coordinatorMemoryDirFor('grok')).toBe(path.join(os.homedir(), '.claude'));
  });
});

describe('makeCoordinatorPolicy commandsEscalate (Codex read-only) — B1', () => {
  const dir = path.join(os.homedir(), '.codex');

  it('denies every escalated shell command (writes, interpreters, symlink, cp — and even a read)', () => {
    const policy = makeCoordinatorPolicy(dir, { commandsEscalate: true });
    expect(policy('Bash', { command: 'printf x > /repo/src/index.ts' }).allow).toBe(false);
    expect(policy('Bash', { command: 'node -e "require(\'fs\').writeFileSync(\'/repo/a\',\'x\')"' }).allow).toBe(false);
    expect(policy('Bash', { command: 'ln -s /repo /Users/x/.codex/link' }).allow).toBe(false);
    expect(policy('Bash', { command: 'cp /tmp/x /repo/x' }).allow).toBe(false);
    // Reads never surface under a read-only sandbox, so a surfaced read is anomalous — deny defensively.
    expect(policy('Bash', { command: 'ls -la' }).allow).toBe(false);
  });

  it('still allows a memory-dir ApplyPatch/Write', () => {
    const policy = makeCoordinatorPolicy(dir, { commandsEscalate: true });
    expect(policy('Write', { file_path: path.join(dir, 'notes.md') })).toEqual({ allow: true });
  });

  it('leaves the Claude denylist behavior unchanged when commandsEscalate is false', () => {
    const policy = makeCoordinatorPolicy(path.join(os.homedir(), '.claude'));
    expect(policy('Bash', { command: 'ls -la' })).toEqual({ allow: true });
    expect(policy('Bash', { command: 'git commit -m x' }).allow).toBe(false);
  });
});

describe('makeCoordinatorPolicy symlink containment — M1', () => {
  it('rejects a write that reaches outside the memory dir through a symlinked ancestor', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'covpol-'));
    try {
      const mem = path.join(tmp, 'mem');
      fs.mkdirSync(mem);
      const outside = path.join(tmp, 'outside');
      fs.mkdirSync(outside);
      fs.symlinkSync(outside, path.join(mem, 'link')); // mem/link -> outside
      const policy = makeCoordinatorPolicy(mem);
      expect(policy('Write', { file_path: path.join(mem, 'link', 'escaped.md') }).allow).toBe(false);
      expect(policy('Write', { file_path: path.join(mem, 'ok.md') })).toEqual({ allow: true });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('makeCoordinatorPolicy dangling symlink / loop — M1 residual (F1)', () => {
  it('denies a write whose target is a DANGLING symlink pointing outside the memory dir', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'covdang-'));
    try {
      const mem = path.join(tmp, 'mem');
      fs.mkdirSync(mem);
      // mem/plan.md -> tmp/outside/absent.ts (the destination does NOT exist)
      fs.symlinkSync(path.join(tmp, 'outside', 'absent.ts'), path.join(mem, 'plan.md'));
      const policy = makeCoordinatorPolicy(mem);
      expect(policy('Write', { file_path: path.join(mem, 'plan.md') }).allow).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('denies a write through a DANGLING symlinked ancestor', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'covdang2-'));
    try {
      const mem = path.join(tmp, 'mem');
      fs.mkdirSync(mem);
      fs.symlinkSync(path.join(tmp, 'gone'), path.join(mem, 'dir')); // mem/dir -> tmp/gone (absent)
      const policy = makeCoordinatorPolicy(mem);
      expect(policy('Write', { file_path: path.join(mem, 'dir', 'x.md') }).allow).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('denies a `..` traversal that follows a symlink out of the memory dir (Astra verify #2)', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'covsymdd-'));
    try {
      const mem = path.join(tmp, 'mem');
      fs.mkdirSync(mem);
      const outsideDir = path.join(tmp, 'repo', 'subdir');
      fs.mkdirSync(outsideDir, { recursive: true });
      fs.symlinkSync(outsideDir, path.join(mem, 'link')); // mem/link -> tmp/repo/subdir (exists)
      const policy = makeCoordinatorPolicy(mem);
      // Build the path by raw concatenation — path.join would collapse the `..` lexically before
      // the policy ever sees it. On disk mem/link/../victim.ts resolves to tmp/repo/victim.ts,
      // OUTSIDE mem. A lexical path.resolve would wrongly fold it to mem/victim.ts and allow it.
      const attack = `${mem}${path.sep}link${path.sep}..${path.sep}victim.ts`;
      expect(policy('Write', { file_path: attack }).allow).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('fails closed on a symlink LOOP (non-ENOENT realpath error, Astra verify #3)', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'covloop-'));
    try {
      const mem = path.join(tmp, 'mem');
      fs.mkdirSync(mem);
      fs.symlinkSync(path.join(mem, 'loop'), path.join(mem, 'loop')); // mem/loop -> mem/loop (ELOOP)
      const policy = makeCoordinatorPolicy(mem);
      expect(policy('Write', { file_path: path.join(mem, 'loop', 'x.md') }).allow).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('makeCoordinatorPolicy unverifiable change — F3', () => {
  it('denies a patch when any change entry has neither a path nor a dest', () => {
    const dir = path.join(os.homedir(), '.codex');
    const policy = makeCoordinatorPolicy(dir);
    expect(policy('Write', { changes: [{ path: path.join(dir, 'a.md') }, { kind: 'update' }] }).allow).toBe(false);
  });
});

describe('makeCoordinatorPolicy ApplyPatch move destination — M2', () => {
  it('denies a change whose move destination leaves the memory dir', () => {
    const dir = path.join(os.homedir(), '.codex');
    const policy = makeCoordinatorPolicy(dir);
    expect(policy('Write', { changes: [{ path: path.join(dir, 'a.md'), dest: '/repo/src/x.ts' }] }).allow).toBe(false);
  });

  it('allows a change whose source and destination both stay under the memory dir', () => {
    const dir = path.join(os.homedir(), '.codex');
    const policy = makeCoordinatorPolicy(dir);
    expect(policy('Write', { changes: [{ path: path.join(dir, 'a.md'), dest: path.join(dir, 'b.md') }] })).toEqual({ allow: true });
  });
});

describe('makeCoordinatorPolicy relative targets and a resolve-once memory dir (review L4)', () => {
  it('denies a relative target even when the daemon process cwd sits inside the memory dir', () => {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'coord-rel-')));
    const mem = path.join(base, 'mem');
    fs.mkdirSync(mem);
    const prevCwd = process.cwd();
    process.chdir(mem); // a relative path would resolve "under" the memory dir from HERE
    try {
      const policy = makeCoordinatorPolicy(mem);
      // …but Codex anchors it to the THREAD cwd (the repo), so it must be denied.
      expect(policy('Write', { file_path: 'notes.md' }).allow).toBe(false);
      expect(policy('Write', { file_path: path.join(mem, 'notes.md') }).allow).toBe(true);
    } finally {
      process.chdir(prevCwd);
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it('denies a nested relative target (fail closed)', () => {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'coord-rel2-')));
    const prevCwd = process.cwd();
    process.chdir(base);
    try {
      const policy = makeCoordinatorPolicy(base);
      expect(policy('Write', { file_path: path.join('sub', 'notes.md') }).allow).toBe(false);
    } finally {
      process.chdir(prevCwd);
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it('pins the memory dir to its real path when the policy is built (a later swap to a symlink does not widen it)', () => {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'coord-pin-')));
    const mem = path.join(base, 'mem');
    const repo = path.join(base, 'repo');
    fs.mkdirSync(mem);
    fs.mkdirSync(repo);
    try {
      const policy = makeCoordinatorPolicy(mem);
      fs.rmSync(mem, { recursive: true });
      fs.symlinkSync(repo, mem); // mem -> repo AFTER the policy was built
      expect(policy('Write', { file_path: path.join(mem, 'x.ts') }).allow).toBe(false);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});
