// Smart approvals on Claude Code (--permission-mode auto): the box's own card-only and state-only
// tools get `permissions.allow` rules so auto mode's classifier cannot refuse them. A system's data
// tools get no allow rule (the classifier still judges them). Other threads are unchanged.
import { it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import * as sessionsDb from '../../src/db/sessions.js';
import { SessionService } from '../../src/sessions/service.js';
import { PTYManager } from '../../src/pty/manager.js';
import { StructuredSessionManager } from '../../src/structured/manager.js';
import { setProfileSource, fallbackProfile, type Profile } from '../../src/os/profile.js';
import { osServerSpecs, resetCurrentOsServerNames } from '../../src/os/os-servers.js';

class NoPty extends PTYManager {
  override spawn(): number { return 1; }
  override isAlive(): boolean { return false; }
  override kill(): void {}
  override killAll(): void {}
}
class CapturingClaude extends StructuredSessionManager {
  calls: { args: string[] }[] = [];
  override isAlive(): boolean { return false; }
  override spawn(_id: string, opts: { command: string; args: string[] }): number { this.calls.push({ args: opts.args }); return 9; }
  override kill(): void {}
}

let sandbox: string; let svc: SessionService; let claude: CapturingClaude;
function setup(profile: Profile): void {
  setProfileSource(() => profile);
  svc.setIntegrationsSpecs(() => [
    { name: 'own-notes', command: 'node', args: ['/x.js'] },
    ...osServerSpecs({ daemonApi: 'http://127.0.0.1:1', systems: ['os', 'crm', 'mail_box'], bridgePath: '/bridge.js' }),
  ]);
}
const permissionsOf = (args: string[]): Record<string, string[]> | undefined => JSON.parse(args[args.indexOf('--settings') + 1]).permissions;

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'smart-allow-'));
  fs.mkdirSync(path.join(sandbox, 'proj'));
  const db = new Database(':memory:'); initSchema(db);
  sessionsDb.create(db, { id: 's1', provider: 'claude-code', name: 't', workingDir: path.join(sandbox, 'proj') });
  svc = new SessionService(db, new NoPty(), path.join(sandbox, 'mcp.json'));
  claude = new CapturingClaude();
  svc.registerStructuredManager('claude-code', claude);
  resetCurrentOsServerNames();
});
afterEach(() => { setProfileSource(() => fallbackProfile(process.env)); resetCurrentOsServerNames(); fs.rmSync(sandbox, { recursive: true, force: true }); });

it('a smart business chat thread allows every connect tool and the connections list/refresh, and no data tool', () => {
  setup('business');
  svc.createTerminal('s1', 'claude-code', 'A', false, undefined, undefined, { transport: 'structured' });
  const args = claude.calls[0].args;
  expect(args.join(' ')).toContain('--permission-mode auto');
  const perms = permissionsOf(args)!;
  expect(perms.allow).toEqual(expect.arrayContaining(['mcp__crm__connect', 'mcp__mail-box__connect', 'mcp__connections__list', 'mcp__connections__refresh']));
  expect(perms.allow).toHaveLength(4);
  for (const rule of perms.allow) expect(rule).toMatch(/__(connect|list|refresh)$/);
  expect(perms.allow.some((r) => r.startsWith('mcp__crm__') && !r.endsWith('__connect'))).toBe(false);
  expect(perms.allow.some((r) => r.includes('own-notes'))).toBe(false);
  expect(perms.ask).toBeUndefined(); // no ask rules today; unchanged
});

it('an explicit smart thread of a developer gets the same allow rules', () => {
  setup('developer');
  svc.createTerminal('s1', 'claude-code', 'A', false, undefined, undefined, { transport: 'structured', approvals: 'smart' });
  expect(permissionsOf(claude.calls[0].args)?.allow).toContain('mcp__crm__connect');
});

it('a developer thread with no approvals setting is unchanged: default mode, no permission rules', () => {
  setup('developer');
  svc.createTerminal('s1', 'claude-code', 'A', false, undefined, undefined, { transport: 'structured' });
  const args = claude.calls[0].args;
  expect(args.join(' ')).toContain('--permission-mode default');
  expect(permissionsOf(args)).toBeUndefined();
});

it('a thread set to auto or ask approvals is unchanged: no permission rules (business threads are always smart)', () => {
  setup('developer');
  svc.createTerminal('s1', 'claude-code', 'A', false, undefined, undefined, { transport: 'structured', approvals: 'auto' });
  svc.createTerminal('s1', 'claude-code', 'B', false, undefined, undefined, { transport: 'structured', approvals: 'ask' });
  for (const c of claude.calls) {
    expect(c.args.join(' ')).toContain('--permission-mode default');
    expect(permissionsOf(c.args)).toBeUndefined();
  }
});
