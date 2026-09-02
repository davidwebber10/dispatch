import { describe, expect, it } from 'vitest';
import { roleToolPolicy } from './role-policy.js';

const observe = roleToolPolicy('observe');
const stage = roleToolPolicy('stage');
const stageDeploy = roleToolPolicy('stage-deploy');

describe('roleToolPolicy — rules that hold at every authority', () => {
  const levels: Array<[string, ReturnType<typeof roleToolPolicy>]> = [
    ['observe', observe],
    ['stage', stage],
    ['stage-deploy', stageDeploy],
  ];

  it('denies a bare git push at every level', () => {
    for (const [name, policy] of levels) {
      expect(policy('Bash', { command: 'git push' }).allow, name).toBe(false);
      expect(policy('Bash', { command: 'git push origin' }).allow, name).toBe(false);
    }
  });

  it('denies an explicit push to main/master/prod at every level', () => {
    for (const [name, policy] of levels) {
      for (const cmd of ['git push origin main', 'git push origin master', 'git push origin prod', 'git push origin production']) {
        expect(policy('Bash', { command: cmd }).allow, `${name}: ${cmd}`).toBe(false);
      }
    }
  });

  it('denies ALL gh pr merge at every level', () => {
    for (const [name, policy] of levels) {
      expect(policy('Bash', { command: 'gh pr merge 12' }).allow, name).toBe(false);
      expect(policy('Bash', { command: 'gh -R owner/repo pr merge 1' }).allow, name).toBe(false);
    }
  });

  it('denies gh workflow run with environment=production at every level', () => {
    for (const [name, policy] of levels) {
      expect(policy('Bash', { command: 'gh workflow run deploy.yml -f environment=production' }).allow, name).toBe(false);
    }
  });

  it('denies ambiguous gh workflow run (no environment) at every level', () => {
    for (const [name, policy] of levels) {
      expect(policy('Bash', { command: 'gh workflow run deploy.yml' }).allow, name).toBe(false);
    }
  });

  it('denies gh release, publish, dispatch update/release, terraform apply/destroy at every level', () => {
    for (const [name, policy] of levels) {
      for (const cmd of [
        'gh release create v1',
        'npm publish',
        'pnpm publish',
        'yarn publish',
        'dispatch update',
        './bin/dispatch release 1.2.3',
        'terraform apply',
        'terraform destroy',
      ]) {
        expect(policy('Bash', { command: cmd }).allow, `${name}: ${cmd}`).toBe(false);
      }
    }
  });

  it('denies native subagents (Agent/Task) at every level, pointing at doing the work directly', () => {
    for (const [name, policy] of levels) {
      const d = policy('Agent', { prompt: 'go research' });
      expect(d.allow, name).toBe(false);
      if (!d.allow) expect(d.message).toContain('subagent');
      expect(policy('Task', {}).allow, name).toBe(false);
    }
  });

  it('allows read-only bash at every level', () => {
    for (const [name, policy] of levels) {
      for (const cmd of ['git status', 'git log --oneline -5', 'ls -la', 'gh pr view 12', 'gh pr checks 12']) {
        expect(policy('Bash', { command: cmd }).allow, `${name}: ${cmd}`).toBe(true);
      }
    }
  });
});

describe('roleToolPolicy(observe)', () => {
  it('denies all file writes, naming observe-only as the reason', () => {
    const d = observe('Edit', { file_path: '/repo/src/app.ts' });
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.message).toContain('observe-only');
    expect(observe('Write', { file_path: '/repo/README.md' }).allow).toBe(false);
    expect(observe('MultiEdit', {}).allow).toBe(false);
    expect(observe('NotebookEdit', {}).allow).toBe(false);
  });

  it('denies git commit', () => {
    expect(observe('Bash', { command: 'git commit -m "x"' }).allow).toBe(false);
  });

  it('denies ALL git push, including an explicit non-protected push', () => {
    expect(observe('Bash', { command: 'git push origin stage' }).allow).toBe(false);
    expect(observe('Bash', { command: 'git push origin feature/x' }).allow).toBe(false);
  });

  it('denies gh pr create', () => {
    expect(observe('Bash', { command: 'gh pr create --title x' }).allow).toBe(false);
  });

  it('denies gh workflow run even with environment=staging', () => {
    expect(observe('Bash', { command: 'gh workflow run deploy.yml -f environment=staging' }).allow).toBe(false);
  });
});

describe('roleToolPolicy(stage)', () => {
  it('allows file writes anywhere in the project', () => {
    expect(stage('Edit', { file_path: '/repo/src/app.ts' }).allow).toBe(true);
    expect(stage('Write', { file_path: '/repo/README.md' }).allow).toBe(true);
  });

  it('allows git commit', () => {
    expect(stage('Bash', { command: 'git commit -m "x"' }).allow).toBe(true);
  });

  it('allows an explicit non-protected git push', () => {
    expect(stage('Bash', { command: 'git push origin stage' }).allow).toBe(true);
    expect(stage('Bash', { command: 'git push origin feature/x' }).allow).toBe(true);
  });

  it('allows gh pr create', () => {
    expect(stage('Bash', { command: 'gh pr create --title x' }).allow).toBe(true);
  });

  it('denies gh workflow run entirely, even with environment=staging', () => {
    const d = stage('Bash', { command: 'gh workflow run deploy.yml -f environment=staging' });
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.message).toContain('stage-deploy');
  });
});

describe('roleToolPolicy(stage-deploy)', () => {
  it('inherits stage: file writes, commit, non-protected push, pr create all allowed', () => {
    expect(stageDeploy('Edit', { file_path: '/repo/src/app.ts' }).allow).toBe(true);
    expect(stageDeploy('Bash', { command: 'git commit -m "x"' }).allow).toBe(true);
    expect(stageDeploy('Bash', { command: 'git push origin stage' }).allow).toBe(true);
    expect(stageDeploy('Bash', { command: 'gh pr create --title x' }).allow).toBe(true);
  });

  it('allows gh workflow run with environment=staging (flag-tolerant)', () => {
    expect(stageDeploy('Bash', { command: 'gh workflow run deploy.yml -f environment=staging' }).allow).toBe(true);
    expect(stageDeploy('Bash', { command: 'gh -R owner/repo workflow run deploy.yml -f environment=staging' }).allow).toBe(true);
  });

  it('still denies gh workflow run with environment=production', () => {
    expect(stageDeploy('Bash', { command: 'gh workflow run deploy.yml -f environment=production' }).allow).toBe(false);
  });

  it('still denies an ambiguous gh workflow run (no environment)', () => {
    expect(stageDeploy('Bash', { command: 'gh workflow run deploy.yml' }).allow).toBe(false);
  });
});

describe('roleToolPolicy — deny-first: a chained command cannot smuggle a denied half past an earlier allow', () => {
  it('denies gh pr merge chained after an otherwise-fine push, at stage', () => {
    const d = stage('Bash', { command: 'gh pr merge 1 && git push origin stage' });
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.message).toContain('pr merge');
  });

  it('denies terraform destroy chained after an otherwise-fine push, at stage', () => {
    const d = stage('Bash', { command: 'git push origin stage && terraform destroy' });
    expect(d.allow).toBe(false);
  });

  it('denies a protected-branch push chained before an otherwise-fine staging workflow run, at stage-deploy', () => {
    const d = stageDeploy('Bash', { command: 'git push origin main && gh workflow run deploy.yml -f environment=staging' });
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.message).toContain('main');
  });

  it('denies a second protected-branch push chained after an explicit non-protected one, at stage', () => {
    const d = stage('Bash', { command: 'git push origin stage && git push origin main' });
    expect(d.allow).toBe(false);
  });

  it('denies a protected-branch push chained after an unrelated leading command, at every level', () => {
    for (const [name, policy] of [
      ['observe', observe],
      ['stage', stage],
      ['stage-deploy', stageDeploy],
    ] as const) {
      expect(policy('Bash', { command: 'cd x && git push origin main' }).allow, name).toBe(false);
    }
  });
});

describe('roleToolPolicy — colon refspecs must be checked on the remote side', () => {
  it('denies `git push origin feature:main` (local ref masks a protected remote target)', () => {
    for (const [name, policy] of [
      ['stage', stage],
      ['stage-deploy', stageDeploy],
    ] as const) {
      expect(policy('Bash', { command: 'git push origin feature:main' }).allow, name).toBe(false);
    }
  });

  it('denies `git push origin HEAD:main`', () => {
    expect(stage('Bash', { command: 'git push origin HEAD:main' }).allow).toBe(false);
  });

  it('denies a force-push refspec `git push --force origin +feature:main`', () => {
    expect(stage('Bash', { command: 'git push --force origin +feature:main' }).allow).toBe(false);
  });

  it('still allows a colon refspec targeting a non-protected remote branch', () => {
    expect(stage('Bash', { command: 'git push origin feature:staging' }).allow).toBe(true);
  });
});

describe('roleToolPolicy — bare HEAD/@ push target is ambiguous (invisible to the policy; depends on checkout)', () => {
  it('denies `git push origin HEAD` at stage and stage-deploy', () => {
    for (const [name, policy] of [
      ['stage', stage],
      ['stage-deploy', stageDeploy],
    ] as const) {
      const d = policy('Bash', { command: 'git push origin HEAD' });
      expect(d.allow, name).toBe(false);
      if (!d.allow) expect(d.message).toContain('ambiguous target — name the branch explicitly');
    }
  });

  it('denies `git push origin @` at stage and stage-deploy', () => {
    for (const [name, policy] of [
      ['stage', stage],
      ['stage-deploy', stageDeploy],
    ] as const) {
      const d = policy('Bash', { command: 'git push origin @' });
      expect(d.allow, name).toBe(false);
      if (!d.allow) expect(d.message).toContain('ambiguous target — name the branch explicitly');
    }
  });

  it('denies a case-varied `git push origin Head` too (case-insensitive for HEAD)', () => {
    expect(stage('Bash', { command: 'git push origin Head' }).allow).toBe(false);
  });

  it('still allows `git push origin stage` (an explicitly named, non-ambiguous branch)', () => {
    expect(stage('Bash', { command: 'git push origin stage' }).allow).toBe(true);
    expect(stageDeploy('Bash', { command: 'git push origin stage' }).allow).toBe(true);
  });
});

describe('roleToolPolicy — WORKFLOW_PROD_MSG names the alternative', () => {
  it('tells the caller to stage the work and leave the deploy decision in the report', () => {
    const d = stageDeploy('Bash', { command: 'gh workflow run deploy.yml -f environment=production' });
    expect(d.allow).toBe(false);
    if (!d.allow) {
      expect(d.message).toContain('production deploys are explicit human approval only');
      expect(d.message).toContain('stage the work and leave the deploy decision in your report');
    }
  });
});

describe('roleToolPolicy — unknown authority fails closed as observe', () => {
  it('treats an unrecognized authority string as observe', () => {
    const bogus = roleToolPolicy('bogus' as never);
    expect(bogus('Edit', { file_path: '/repo/src/app.ts' }).allow).toBe(false);
    expect(bogus('Bash', { command: 'git commit -m "x"' }).allow).toBe(false);
    expect(bogus('Bash', { command: 'git push origin stage' }).allow).toBe(false);
  });
});

describe('roleToolPolicy — quote-aware segment splitting: a quoted && cannot hide a push target', () => {
  it('denies a push whose flag value contains a quoted && (the segment splitter must not split inside quotes)', () => {
    const d = stage('Bash', { command: 'git push -o "release notes: build && deploy" origin main' });
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.message).toContain('could not verify the push target');
  });

  it('denies a push with an unrecognized flag that takes a value (unclassifiable, fails closed)', () => {
    const d = stage('Bash', { command: 'git push -o ci.skip origin stage' });
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.message).toContain('could not verify the push target');
  });

  it('still allows a clean, plain-form push at stage', () => {
    expect(stage('Bash', { command: 'git push origin stage' }).allow).toBe(true);
  });

  it('still allows a push with the safe --force flag at stage', () => {
    expect(stage('Bash', { command: 'git push --force origin stage' }).allow).toBe(true);
  });

  it('still denies a main push chained after a commit whose message contains a quoted &&', () => {
    const d = stage('Bash', { command: 'git commit -m "notes: build && deploy" && git push origin main' });
    expect(d.allow).toBe(false);
  });

  it('denies a command with an unbalanced quote that contains a push to main (fail-closed single segment)', () => {
    const d = stage('Bash', { command: 'echo "unterminated && git push origin main' });
    expect(d.allow).toBe(false);
  });

  it('still allows a clean gh workflow run at stage-deploy — checkWorkflowRun shares the quote-aware splitter', () => {
    expect(stageDeploy('Bash', { command: 'gh workflow run deploy.yml -f environment=staging' }).allow).toBe(true);
  });

  it('denies a workflow run whose earlier chained clause is hidden by a quoted &&', () => {
    const d = stage('Bash', {
      command: 'git commit -m "notes: build && deploy" && gh workflow run deploy.yml -f environment=production',
    });
    expect(d.allow).toBe(false);
  });
});

describe('roleToolPolicy — canonical refs/heads/ form and case-insensitivity cannot mask a protected branch', () => {
  it('denies a colon refspec whose remote side is the fully-qualified refs/heads/main', () => {
    expect(stage('Bash', { command: 'git push origin feature:refs/heads/main' }).allow).toBe(false);
  });

  it('denies HEAD:refs/heads/main', () => {
    expect(stage('Bash', { command: 'git push origin HEAD:refs/heads/main' }).allow).toBe(false);
  });

  it('denies a differently-cased branch name (MAIN)', () => {
    expect(stage('Bash', { command: 'git push origin MAIN' }).allow).toBe(false);
  });

  it('still allows a canonical refs/heads/ push to a non-protected branch', () => {
    expect(stage('Bash', { command: 'git push origin refs/heads/stage' }).allow).toBe(true);
  });
});

describe("roleToolPolicy — git's dst-disambiguation of an unprefixed heads/<name> form", () => {
  it('denies HEAD:heads/main (git resolves unprefixed heads/main to refs/heads/main)', () => {
    expect(stage('Bash', { command: 'git push origin HEAD:heads/main' }).allow).toBe(false);
  });

  it('denies feature:heads/main', () => {
    expect(stage('Bash', { command: 'git push origin feature:heads/main' }).allow).toBe(false);
  });

  it('denies heads/main as the sole positional-branch form', () => {
    expect(stage('Bash', { command: 'git push origin heads/main' }).allow).toBe(false);
  });

  it('denies case-mixed HEAD:Refs/Heads/main (free hardening)', () => {
    expect(stage('Bash', { command: 'git push origin HEAD:Refs/Heads/main' }).allow).toBe(false);
  });

  it('still allows refs/heads/stage', () => {
    expect(stage('Bash', { command: 'git push origin refs/heads/stage' }).allow).toBe(true);
  });

  it('still allows a plain non-protected branch name', () => {
    expect(stage('Bash', { command: 'git push origin stage' }).allow).toBe(true);
  });

  it('still allows tags/main — a tag named main is not branch main', () => {
    expect(stage('Bash', { command: 'git push origin tags/main' }).allow).toBe(true);
  });
});
