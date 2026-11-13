import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { parseModelAccess } from './company-model.js';
import { applyLoginDropIn, companyClaudePermitted, LOGIN_DROPIN_FILE, mayLiftForcedLogin, syncLoginPolicy } from './login-policy.js';
import { boxCapabilities, COMPANY_CLAUDE_CAPABILITY } from '../platform/capabilities.js';

const MODEL = 'claude-opus-5-5';
const access = (patch: Record<string, unknown> = {}) => parseModelAccess({
  models: [MODEL], default: MODEL, subscriptions: { claude: false }, seatFirst: true, modelHarness: { [MODEL]: 'claude-code' }, ...patch,
});

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

/** The image's layout in a temp folder, owned by the test's own user (who plays root here). */
function layout(opts: { mainForces?: boolean; dropIn?: boolean } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'login-policy-'));
  dirs.push(root);
  const run = path.join(root, 'run');
  const dir = path.join(run, 'claude-policy');
  fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
  fs.chmodSync(run, 0o755);
  fs.chmodSync(dir, 0o755);
  const etc = path.join(root, 'etc');
  fs.mkdirSync(etc);
  const link = path.join(etc, 'managed-settings.d');
  fs.symlinkSync(dir, link);
  const main = path.join(etc, 'managed-settings.json');
  fs.writeFileSync(main, JSON.stringify({ ...(opts.mainForces ? { forceLoginMethod: 'claudeai' } : {}), permissions: { disableBypassPermissionsMode: 'disable' } }));
  if (opts.dropIn) fs.writeFileSync(path.join(dir, LOGIN_DROPIN_FILE), '{"forceLoginMethod":"claudeai"}\n', { mode: 0o644 });
  const env = { DISPATCH_CLAUDE_POLICY_DIR: dir, DISPATCH_CLAUDE_POLICY_LINK: link, DISPATCH_CLAUDE_MANAGED_FILE: main } as NodeJS.ProcessEnv;
  return { dir, link, main, env, paths: { dir, link } };
}
const me = typeof process.getuid === 'function' ? process.getuid() : 0;

describe('when the forced login may be lifted', () => {
  test('only for a granted company Claude model with the own Claude login turned off; no answer keeps it', () => {
    expect(mayLiftForcedLogin(access())).toBe(true);
    expect(mayLiftForcedLogin(null)).toBe(false);
    expect(mayLiftForcedLogin(access({ subscriptions: { claude: true } }))).toBe(false);
    expect(mayLiftForcedLogin(access({ subscriptions: {}, subscriptionsAllowed: true }))).toBe(false);
    expect(mayLiftForcedLogin(access({ models: [] }))).toBe(false);
    expect(mayLiftForcedLogin(access({ models: ['gpt-6.1-sol'], modelHarness: { 'gpt-6.1-sol': 'codex' } }))).toBe(false);
  });
});

describe('the login drop-in', () => {
  test('written atomically (root-owned, 644), removed, and written back as the answer changes', () => {
    const l = layout({ dropIn: false });
    const file = path.join(l.dir, LOGIN_DROPIN_FILE);
    expect(syncLoginPolicy(null, { paths: l.paths, uid: me, owner: me })).toEqual({ forced: true, problem: null });
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ forceLoginMethod: 'claudeai' });
    expect(fs.statSync(file).mode & 0o777).toBe(0o644);
    expect(fs.readdirSync(l.dir).filter((n) => n.startsWith('.'))).toEqual([]);
    expect(syncLoginPolicy(access(), { paths: l.paths, uid: me, owner: me })).toEqual({ forced: false, problem: null });
    expect(fs.existsSync(file)).toBe(false);
    expect(syncLoginPolicy(access({ subscriptions: { claude: true } }), { paths: l.paths, uid: me, owner: me })).toEqual({ forced: true, problem: null });
    expect(fs.existsSync(file)).toBe(true);
    // The model-gateway mode never forces it.
    expect(syncLoginPolicy(null, { gateway: true, paths: l.paths, uid: me, owner: me }).forced).toBe(false);
    expect(fs.existsSync(file)).toBe(false);
  });
  test('a daemon that is not root, or a folder another user may change, changes nothing', () => {
    const l = layout({ dropIn: true });
    const file = path.join(l.dir, LOGIN_DROPIN_FILE);
    expect(applyLoginDropIn(false, l.paths, me + 1, me)).toMatch(/not root/);
    expect(fs.existsSync(file)).toBe(true);
    fs.chmodSync(l.dir, 0o777);
    expect(applyLoginDropIn(false, l.paths, me, me)).toMatch(/may be changed by another user/);
    expect(fs.existsSync(file)).toBe(true);
  });
});

describe('company-claude-v1 is reported only while no managed file forces the login', () => {
  test('the drop-in, the main file, an unreadable drop-in; no folder and no file: permitted', () => {
    expect(companyClaudePermitted(layout({ dropIn: true }).env)).toBe(false);
    expect(companyClaudePermitted(layout({ mainForces: true }).env)).toBe(false);
    const l = layout();
    expect(companyClaudePermitted(l.env)).toBe(true);
    fs.writeFileSync(path.join(l.dir, '50-dispatch-business-mcp.json'), '{"allowManagedMcpServersOnly":true}');
    fs.writeFileSync(path.join(l.dir, '.10-dispatch-login.json.1.tmp'), '{"forceLoginMethod":"claudeai"}');
    expect(companyClaudePermitted(l.env)).toBe(true); // a hidden file is not read by Claude Code
    fs.writeFileSync(path.join(l.dir, '60-broken.json'), '{not json');
    expect(companyClaudePermitted(l.env)).toBe(false);
    const none = { DISPATCH_CLAUDE_POLICY_LINK: '/nonexistent/managed-settings.d', DISPATCH_CLAUDE_MANAGED_FILE: '/nonexistent/managed-settings.json' } as NodeJS.ProcessEnv;
    expect(companyClaudePermitted(none)).toBe(true);
  });
  test('boxCapabilities follows it', () => {
    expect(boxCapabilities(layout({ dropIn: true }).env)).not.toContain(COMPANY_CLAUDE_CAPABILITY);
    expect(boxCapabilities(layout().env)).toContain(COMPANY_CLAUDE_CAPABILITY);
  });
});
