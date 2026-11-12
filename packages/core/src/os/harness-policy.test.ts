import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { fileURLToPath } from 'node:url';
import { harnessPolicyIsStrict } from './harness-policy.js';

const POLICY = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../../../docker/hosted/policy');

describe('the harness policy of the image', () => {
  test('the standard and the gateway file are strict; the developer file is not; a missing or broken file is not', () => {
    expect(harnessPolicyIsStrict(path.join(POLICY, 'claude-managed-settings.json'))).toBe(true);
    expect(harnessPolicyIsStrict(path.join(POLICY, 'claude-managed-settings.gateway.json'))).toBe(true);
    expect(harnessPolicyIsStrict(path.join(POLICY, 'claude-managed-settings.developer.json'))).toBe(false);
    expect(harnessPolicyIsStrict(path.join(POLICY, 'no-such-file.json'))).toBe(false);
    const broken = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'policy-')), 'm.json');
    fs.writeFileSync(broken, '{not json');
    expect(harnessPolicyIsStrict(broken)).toBe(false);
  });

  test('the standard file holds exactly the keys that were measured against the pinned CLI', () => {
    const standard = JSON.parse(fs.readFileSync(path.join(POLICY, 'claude-managed-settings.json'), 'utf8'));
    expect(standard).toEqual({
      forceLoginMethod: 'claudeai',
      permissions: { disableBypassPermissionsMode: 'disable' },
      allowManagedHooksOnly: true,
      allowManagedPermissionRulesOnly: true,
    });
    // The gateway mode drops only the login method: approvals are as strict.
    const gateway = JSON.parse(fs.readFileSync(path.join(POLICY, 'claude-managed-settings.gateway.json'), 'utf8'));
    expect(gateway).toEqual({ ...standard, forceLoginMethod: undefined });
    const codex = fs.readFileSync(path.join(POLICY, 'codex-requirements.toml'), 'utf8');
    expect(codex).toMatch(/^allowed_approval_policies = \["untrusted", "on-request"\]$/m);
    expect(codex).toMatch(/^allowed_sandbox_modes = \["read-only", "workspace-write"\]$/m);
    const settings = codex.split('\n').filter((l) => !l.startsWith('#')).join('\n');
    expect(settings).not.toMatch(/never|danger-full-access/);
  });

  test('the image installs the policy root-owned, strips setuid bits and does not run as root by default', () => {
    const dockerfile = fs.readFileSync(path.join(POLICY, '../Dockerfile'), 'utf8');
    expect(dockerfile).toMatch(/install -m 644 \/opt\/dispatch\/policy\/claude-managed-settings\.json \/etc\/claude-code\/managed-settings\.json/);
    expect(dockerfile).toMatch(/install -m 644 \/opt\/dispatch\/policy\/codex-requirements\.toml \/etc\/codex\/requirements\.toml/);
    expect(dockerfile).toMatch(/find \/ -xdev -type f -perm \/6000 -exec chmod a-s/);
    expect(dockerfile).toMatch(/^FROM \$\{NODE_IMAGE\} AS runtime$/m);
    expect(dockerfile).toMatch(/^ARG NODE_IMAGE=node:[\w.-]+@sha256:[0-9a-f]{64}$/m);
    expect(dockerfile).toMatch(/^ARG CLAUDE_SHA256_ARM64=[0-9a-f]{64}$/m);
    // The last USER of the runtime stage is the runtime user.
    const runtime = dockerfile.slice(dockerfile.indexOf('AS runtime\n'), dockerfile.indexOf('AS runtime-dev'));
    expect(runtime.match(/^USER (\S+)$/gm)?.pop()).toBe('USER dispatch');
    // No installer script is piped into a shell, and no compiler is installed in the runtime stage.
    expect(dockerfile).not.toMatch(/\|\s*(ba)?sh\b/);
    const commands = runtime.split('\n').filter((l) => !l.trimStart().startsWith('#')).join('\n');
    expect(commands).not.toMatch(/build-essential|python3|\bcurl\b|\bunzip\b|\bgcc\b|\bmake\b/);
  });
});
