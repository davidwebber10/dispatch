import { describe, expect, test } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ClaudeStructuredSessionManager } from '../structured/manager.js';
import { approvalsFor, acpSmartAllows, isSafeCommand, opencodeSmartPermission, claudeSmartSettings, approvalTitle } from './approvals.js';
import { claudeCodeProvider as claudeCode } from '../providers/claude-code.js';
import { describeReviewAction } from '../structured/codex-manager.js';
import { setCurrentOsServerNames, resetCurrentOsServerNames } from './os-servers.js';

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../tests/fixtures/fake-claude-smart.mjs');
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(fn: () => T | undefined | null | false, ms = 3000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) { const v = fn(); if (v) return v as T; if (Date.now() > end) throw new Error('timed out'); await wait(20); }
}

function start(env: Record<string, string> = {}, smart = true) {
  const m = new ClaudeStructuredSessionManager();
  const events: any[] = [];
  const pendings: any[] = [];
  m.on('event', (_id: string, e: any) => events.push(e));
  m.on('permission', (_id: string, p: any) => pendings.push(p));
  m.spawn('t1', { command: process.execPath, args: [FAKE, '--permission-mode', smart ? 'auto' : 'default'], workDir: process.cwd(), env, ...(smart ? { approvals: 'smart' as const } : {}) } as any);
  return { m, events, pendings };
}

describe('smart approvals — Claude Code (scripted CLI)', () => {
  test('a classifier block becomes a card; a rule-forced can_use_tool is surfaced, never auto-allowed', async () => {
    const { m, events, pendings } = start();
    m.sendMessage('t1', 'please BLOCK');
    const card = await until(() => events.find((e) => e.subtype === 'permission_blocked'));
    expect(card.block).toMatchObject({ id: 'toolu_9', toolName: 'Bash', title: 'Wants to run a command', detail: 'git push --force origin main', reason: '[Git Destructive]' });
    const p = await until(() => pendings[0]);
    expect(p).toMatchObject({ toolName: 'Bash', input: { command: 'chmod 777 x' } });
    expect(events.some((e) => e.subtype === 'fake_answer')).toBe(false); // nothing was answered for the person
    expect(m.getBlocked('t1').map((b) => b.id)).toEqual(['toolu_9']);
    // "Allow this": a message that names and approves the action.
    expect(await m.resolveBlocked('t1', 'toolu_9', 'allow')).toBe(true);
    const sent = await until(() => events.find((e) => e.subtype === 'fake_user' && e.text.includes('I approve')));
    expect(sent.text).toContain('git push --force origin main');
    expect(events.some((e) => e.subtype === 'permission_blocked_resolved' && e.decision === 'allow')).toBe(true);
    expect(m.getBlocked('t1')).toEqual([]);
    expect(await m.resolveBlocked('t1', 'toolu_9', 'keep')).toBe(false);
    m.kill('t1');
  });

  test('the CLI silently ran another mode: one plain notice, and every tool is asked for', async () => {
    const { m, events, pendings } = start({ FAKE_NO_AUTO: '1' });
    const note = await until(() => events.find((e) => e.subtype === 'dispatch_notice'));
    expect(note.message).toMatch(/Smart approvals are not available/);
    m.sendMessage('t1', 'BLOCK');
    await until(() => pendings[0]);
    expect(events.filter((e) => e.subtype === 'dispatch_notice')).toHaveLength(1);
    m.kill('t1');
  });

  test('live switch: set_permission_mode auto; a model without auto mode falls back with the notice', async () => {
    const ok = start({}, false);
    await ok.m.setApprovals('t1', 'smart');
    await until(() => ok.events.find((e) => e.subtype === 'status' && e.permissionMode === 'auto'));
    expect(ok.events.some((e) => e.subtype === 'dispatch_notice')).toBe(false);
    await ok.m.setApprovals('t1', 'auto');
    await until(() => ok.events.find((e) => e.subtype === 'status' && e.permissionMode === 'default'));
    ok.m.kill('t1');

    const no = start({ FAKE_NO_AUTO: '1' }, false);
    await no.m.setApprovals('t1', 'smart');
    expect(no.events.some((e) => e.subtype === 'dispatch_notice')).toBe(true);
    no.m.kill('t1');
  });
});

describe('smart approvals — rules and wiring', () => {
  test('business plain threads default to smart; developer and agents keep today\'s rule', () => {
    expect(approvalsFor({}, 'business')).toBe('smart');
    expect(approvalsFor({}, 'developer')).toBeNull();
    expect(approvalsFor({ role: 'agent' }, 'business')).toBeNull();
    expect(approvalsFor({ approvals: 'ask' }, 'business')).toBe('ask');
  });

  test('the Claude command: auto mode, plus ask rules only when there are rules', () => {
    const smart = claudeCode.buildStructuredCommand!({ workDir: '/w', smartApprovals: { settings: claudeSmartSettings(['mcp__gmail__send']) } });
    expect(smart.args.join(' ')).toContain('--permission-mode auto');
    expect(smart.args).toContain('{"permissions":{"ask":["mcp__gmail__send"]}}');
    const plain = claudeCode.buildStructuredCommand!({ workDir: '/w' });
    expect(plain.args.join(' ')).toContain('--permission-mode default');
    expect(claudeSmartSettings([])).toBeNull();
  });

  test('the Grok rule set', () => {
    expect(acpSmartAllows('read', 'Read', { path: 'src/a.ts' }, '/p')).toBe(true);
    expect(acpSmartAllows('read', 'Read', { path: '/etc/passwd' }, '/p')).toBe(false);
    expect(acpSmartAllows('edit', 'Edit', { path: '/p/x.ts' }, '/p')).toBe(true);
    expect(acpSmartAllows('edit', 'Edit', {}, '/p')).toBe(false);
    expect(acpSmartAllows('execute', 'Bash', { command: 'git status' }, '/p')).toBe(true);
    expect(acpSmartAllows('execute', 'Bash', { command: 'git status && rm -rf /' }, '/p')).toBe(false);
    expect(acpSmartAllows('fetch', 'WebFetch', { url: 'https://x' }, '/p')).toBe(false);
    setCurrentOsServerNames(['zendesk', 'gmail', 'connections']);
    expect(acpSmartAllows(undefined, 'zendesk_search', {}, '/p')).toBe(true);
    expect(acpSmartAllows(undefined, 'mcp__zendesk__search_tickets', {}, '/p')).toBe(true);
    expect(acpSmartAllows(undefined, 'connections__list', {}, '/p')).toBe(true);
    expect(acpSmartAllows(undefined, 'gmail_send', {}, '/p')).toBe(false);
    // A server that is not a company system: never a company read.
    expect(acpSmartAllows(undefined, 'github_search', {}, '/p')).toBe(false);
    resetCurrentOsServerNames();
    expect(isSafeCommand('ls -la')).toBe(true);
    expect(isSafeCommand('ls $(rm x)')).toBe(false);
  });

  test('the OpenCode rule set asks by default and for web and shell', () => {
    const p = opencodeSmartPermission() as any;
    expect(p['*']).toBe('ask');
    expect(p.edit).toBe('allow');
    expect(p.webfetch).toBe('ask');
    expect(p.bash['*']).toBe('ask');
    expect(p.bash['git status *']).toBe('allow');
    const q = opencodeSmartPermission(['acumatica', 'connections']) as any;
    expect(q['acumatica_*']).toBe('ask');
    expect(q['acumatica_*search*']).toBe('allow');
    expect(q['connections_*list*']).toBe('allow');
    expect(JSON.stringify(q)).not.toContain('os-tools');
  });

  test('Codex reviewed actions read as plain lines', () => {
    expect(describeReviewAction({ type: 'command', command: 'rm -rf build', cwd: '/p', source: 'shell' })).toEqual({ toolName: 'Bash', detail: 'rm -rf build' });
    expect(describeReviewAction({ type: 'networkAccess', target: 'https://x', host: 'x', protocol: 'https', port: 443 }).toolName).toBe('WebFetch');
    expect(approvalTitle('mcp__gmail__send')).toBe('Wants to send an email');
  });
});
