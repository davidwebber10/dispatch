import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';
import type { McpServerSpec } from '../mcp/injection.js';
import { composeInjection } from '../mcp/injection.js';
import {
  allowListFor, applyBusinessDropIn, BUSINESS_DROPIN_FILE, businessDropIn, dropInFolderProblem, hostedServerSpecs,
  forbiddenInitTools, initServerNames, unexpectedInitMcpTools, unexpectedServers, unexpectedServersNotice, CLAUDE_HOSTED_MCP_ARGS, CLAUDE_HOSTED_MCP_ENV,
} from './hosted-mcp-policy.js';
import { BUSINESS_MCP_POLICY_MISSING, enforceHostedMcp } from '../sessions/spawn-injection.js';
import { hostedClaudeArgs, hostedClaudeEnv } from '../sessions/thread-spawner.js';
import { claudeChildEnv } from '../structured/manager.js';
import { completeClaudePolicies } from './hosted-claude-policy.js';
import { hostedSpinnerVerbs, parseWordSet, webWordSetsFile } from '../settings/word-sets.js';
import { withHostedDefaults } from '../settings/harness-settings.js';
import { setBoxLogForTest } from './box-log.js';

const POLICY = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../../../docker/hosted/policy');
const API = 'http://127.0.0.1:3456/dispatch';

/** What a hosted thread's spawn composes before the rule: every kind of server there is. */
function composed(): McpServerSpec[] {
  return [
    { name: 'doppler', command: 'node', args: ['/app/packages/doppler-mcp/dist/index.js'] },
    { name: 'github', command: 'npx', args: ['-y', 'some-github-mcp'] },
    { name: 'dispatch', command: 'node', args: ['/app/packages/core/dist/overseer/agency-mcp.js'], authEnv: true, bundled: true, env: { DISPATCH_TERMINAL: 't1' } },
    { name: 'plugin-previews', command: 'node', args: ['/app/packages/plugins/previews/mcp/server.mjs'], authEnv: true, bundled: true },
    { name: 'plugin-mine', command: 'node', args: ['/home/dispatch/.dispatch/plugins/mine/server.mjs'], authEnv: true },
    { name: 'acumatica', command: 'node', args: ['/app/bridge.js'], authEnv: true, http: { url: `${API}/api/os/mcp/acumatica` }, osSystem: 'acumatica' },
    { name: 'connections', command: 'node', args: ['/app/bridge.js'], authEnv: true, http: { url: `${API}/api/os/mcp/os` }, osSystem: 'os' },
    { name: 'os-attached', command: 'npx', args: ['-y', 'mcp-remote@0.14.3', 'https://gateway.example.com/mcp'], platform: true },
  ];
}

afterEach(() => setBoxLogForTest());

describe('the MCP servers of a hosted thread, per profile', () => {
  test('business: the platform systems, Dispatch\'s own server and bundled plugins; developer: everything Dispatch composed', () => {
    expect(hostedServerSpecs(composed(), 'business').map((s) => s.name)).toMatchInlineSnapshot(`
      [
        "dispatch",
        "plugin-previews",
        "acumatica",
        "connections",
        "os-attached",
      ]
    `);
    expect(hostedServerSpecs(composed(), 'developer').map((s) => s.name)).toEqual(composed().map((s) => s.name));
  });

  test('the business drop-in allows exactly the loopback routes and the bundled commands', () => {
    expect(businessDropIn(hostedServerSpecs(composed(), 'business'))).toMatchInlineSnapshot(`
      {
        "allowManagedMcpServersOnly": true,
        "allowedMcpServers": [
          {
            "serverCommand": [
              "node",
              "/app/packages/core/dist/overseer/agency-mcp.js",
            ],
          },
          {
            "serverCommand": [
              "node",
              "/app/packages/plugins/previews/mcp/server.mjs",
            ],
          },
          {
            "serverUrl": "http://127.0.0.1:3456/*",
          },
          {
            "serverCommand": [
              "npx",
              "-y",
              "mcp-remote@0.14.3",
              "https://gateway.example.com/mcp",
            ],
          },
        ],
      }
    `);
  });

  test('each allow-list entry matches the entry Claude Code gets in its --mcp-config', () => {
    const specs = hostedServerSpecs(composed(), 'business');
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mcpcfg-')), 'thread.mcp.json');
    composeInjection(specs, { configPath: file, prompts: [] });
    const servers = JSON.parse(fs.readFileSync(file, 'utf8')).mcpServers as Record<string, { url?: string; command?: string; args?: string[] }>;
    const allow = allowListFor(specs);
    for (const [name, s] of Object.entries(servers)) {
      const ok = s.url
        ? allow.some((e) => 'serverUrl' in e && s.url!.startsWith(e.serverUrl.slice(0, -1)))
        : allow.some((e) => 'serverCommand' in e && JSON.stringify(e.serverCommand) === JSON.stringify([s.command, ...(s.args ?? [])]));
      expect(ok, name).toBe(true);
    }
  });

  test('the launch arguments and environment, per harness; a local install is unchanged', () => {
    const args = ['-p', '--mcp-config', '/x.json', '--disallowedTools', 'AskUserQuestion'];
    expect(hostedClaudeArgs('claude-code', args, true)).toEqual(['--strict-mcp-config', ...args]);
    expect(hostedClaudeArgs('claude-code', args, false)).toEqual(args);
    expect(hostedClaudeArgs('codex', args, true)).toEqual(args);
    expect(hostedClaudeArgs('claude-code', ['--strict-mcp-config', ...args], true)).toEqual(['--strict-mcp-config', ...args]);
    expect(hostedClaudeEnv('claude-code', true)).toEqual({ ENABLE_CLAUDEAI_MCP_SERVERS: 'false', CLAUDE_CODE_ARTIFACT: '0' });
    expect(hostedClaudeEnv('claude-code', false)).toEqual({});
    expect(hostedClaudeEnv('opencode', true)).toEqual({ OPENCODE_DISABLE_PROJECT_CONFIG: '1' });
    expect(hostedClaudeEnv('opencode', false)).toEqual({});
    expect(hostedClaudeEnv('codex', true)).toEqual({});
    expect(CLAUDE_HOSTED_MCP_ARGS).toEqual(['--strict-mcp-config']);
    expect(CLAUDE_HOSTED_MCP_ENV).toEqual({ ENABLE_CLAUDEAI_MCP_SERVERS: 'false', CLAUDE_CODE_ARTIFACT: '0' });
    // The Pretty manager's own default (v4.6.1): Artifact on for a local install, off on a hosted box,
    // whatever the daemon or the thread env says there.
    expect(claudeChildEnv({}, {}, false).CLAUDE_CODE_ARTIFACT).toBe('1');
    expect(claudeChildEnv({}, { CLAUDE_CODE_ARTIFACT: 'false' }, false).CLAUDE_CODE_ARTIFACT).toBe('false');
    expect(claudeChildEnv({}, {}, true).CLAUDE_CODE_ARTIFACT).toBe('0');
    expect(claudeChildEnv({ CLAUDE_CODE_ARTIFACT: '1' }, { CLAUDE_CODE_ARTIFACT: '1' }, true).CLAUDE_CODE_ARTIFACT).toBe('0');
  });
});

describe('the business drop-in on disk', () => {
  const me = process.getuid!();
  function layout(mode = 0o755) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dropin-'));
    fs.chmodSync(root, 0o755);
    const dir = path.join(root, 'claude-policy');
    fs.mkdirSync(dir, { mode });
    fs.chmodSync(dir, mode);
    const link = path.join(root, 'managed-settings.d');
    fs.symlinkSync(dir, link);
    return { dir, link };
  }

  test('written by the owner of the folder, read back, removed for a developer', () => {
    const p = layout();
    const doc = businessDropIn(hostedServerSpecs(composed(), 'business'));
    expect(applyBusinessDropIn(doc, p, me, me)).toBeNull();
    const file = path.join(p.dir, BUSINESS_DROPIN_FILE);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(doc);
    expect(fs.statSync(file).mode & 0o777).toBe(0o644);
    expect(fs.readdirSync(p.dir)).toEqual([BUSINESS_DROPIN_FILE]);
    expect(applyBusinessDropIn(null, p, me, me)).toBeNull();
    expect(fs.existsSync(file)).toBe(false);
  });

  test('a second business spawn with another set keeps the first set allowed (one file for the box)', () => {
    const p = layout();
    expect(applyBusinessDropIn({ allowManagedMcpServersOnly: true, allowedMcpServers: [{ serverUrl: 'http://127.0.0.1:1/*' }] }, p, me, me)).toBeNull();
    expect(applyBusinessDropIn({ allowManagedMcpServersOnly: true, allowedMcpServers: [{ serverCommand: ['node', '/a.js'] }] }, p, me, me)).toBeNull();
    expect(JSON.parse(fs.readFileSync(path.join(p.dir, BUSINESS_DROPIN_FILE), 'utf8')).allowedMcpServers)
      .toEqual([{ serverCommand: ['node', '/a.js'] }, { serverUrl: 'http://127.0.0.1:1/*' }]);
  });

  test('refused: not root, a folder others may write, a link that leads elsewhere', () => {
    const p = layout();
    expect(dropInFolderProblem(p, me + 1, me)).toMatch(/not root/);
    expect(applyBusinessDropIn({ a: 1 }, p, me + 1, me)).toMatch(/not root/);
    const open = layout(0o777);
    expect(dropInFolderProblem(open, me, me)).toMatch(/may be changed by another user/);
    const other = layout();
    expect(dropInFolderProblem({ dir: other.dir, link: p.link }, me, me)).toMatch(/does not lead to/);
    expect(dropInFolderProblem({ dir: p.dir, link: '/no/such/link' }, me, me)).toMatch(/does not lead to a folder/);
  });

  test('enforceHostedMcp: a business thread does not start when the drop-in cannot be written; a developer thread does', () => {
    const lines: string[] = [];
    setBoxLogForTest({ sink: (l) => lines.push(l), enabled: true });
    const biz = composed();
    expect(() => enforceHostedMcp(biz, 'business', () => 'the daemon is not root (no privilege separation)')).toThrow(BUSINESS_MCP_POLICY_MISSING);
    expect(biz.map((s) => s.name)).toEqual(['dispatch', 'plugin-previews', 'acumatica', 'connections', 'os-attached']);
    const dev = composed();
    expect(() => enforceHostedMcp(dev, 'developer', () => 'not root')).not.toThrow();
    expect(dev).toHaveLength(composed().length);
    let written: unknown = 'unset';
    enforceHostedMcp(composed(), 'business', (doc) => { written = doc; return null; });
    expect(written).toEqual(businessDropIn(hostedServerSpecs(composed(), 'business')));
    enforceHostedMcp(composed(), 'developer', (doc) => { written = doc; return null; });
    expect(written).toBeNull();
    expect(lines.map((l) => JSON.parse(l).event)).toContain('thread.mcp.dropped');
    expect(lines.some((l) => JSON.parse(l).event === 'thread.mcp.policy' && JSON.parse(l).level === 'error')).toBe(true);
  });
});

describe('the init-frame check', () => {
  test('names only; an unexpected name is reported', () => {
    const init = { type: 'system', subtype: 'init', mcp_servers: [{ name: 'dispatch', status: 'connected' }, { name: 'claude.ai Gmail', status: 'pending' }] };
    expect(initServerNames(init)).toEqual(['dispatch', 'claude.ai Gmail']);
    expect(initServerNames({ type: 'system', subtype: 'init' })).toBeNull();
    expect(unexpectedServers(['dispatch', 'acumatica'], ['dispatch', 'claude.ai Gmail'])).toEqual(['claude.ai Gmail']);
    expect(forbiddenInitTools({ tools: ['Bash', 'Read', 'Artifact', 'ArtifactComments', 'ArtifactData', 'mcp__dispatch__read_thread'] })).toEqual(['Artifact', 'ArtifactComments', 'ArtifactData']);
    expect(forbiddenInitTools({ tools: ['Bash'] })).toEqual([]);
    expect(unexpectedInitMcpTools(['dispatch', 'plugin-previews', 'claude.ai x'], { tools: ['Bash', 'mcp__dispatch__read_thread', 'mcp__plugin-previews__preview', 'mcp__claude_ai_x__a', 'mcp__claude_ai_Gmail__send', 'mcp__evil__go'] }))
      .toEqual(['mcp__claude_ai_Gmail__send', 'mcp__evil__go']);
    expect(unexpectedInitMcpTools(['dispatch'], {})).toEqual([]);
    expect(unexpectedServersNotice(['claude.ai Gmail'])).toMatchInlineSnapshot(`"This thread's agent program loaded tools that the workspace did not give it: claude.ai Gmail. Do not use them for company data. Tell your administrator."`);
  });
});

describe('the managed policy files the image installs (generated at build)', () => {
  test('every Claude Code file gets the POLYWOOD words of the web client, in mode replace', () => {
    const verbs = hostedSpinnerVerbs(webWordSetsFile());
    expect(verbs).not.toBeNull();
    const files: Record<string, Record<string, unknown>> = {};
    for (const name of fs.readdirSync(POLICY)) if (name.endsWith('.json')) files[name] = JSON.parse(fs.readFileSync(path.join(POLICY, name), 'utf8'));
    expect(completeClaudePolicies(files, verbs!)).toMatchSnapshot();
  });

  test('the word set is read from the web client file, never copied', () => {
    const src = fs.readFileSync(webWordSetsFile(), 'utf8');
    expect(parseWordSet(src, 'POLYWOOD')).toEqual(hostedSpinnerVerbs()?.verbs);
    expect(parseWordSet("{ name: 'X', words: ['a', \"b c\"] }", 'X')).toEqual(['a', 'b c']);
    expect(parseWordSet("{ name: 'X', words: [a] }", 'X')).toBeNull();
    expect(parseWordSet('', 'POLYWOOD')).toBeNull();
  });

  test('the indicator default: POLYWOOD on a hosted box when nothing is chosen; a choice and a local install keep theirs', () => {
    const polywood = { mode: 'replace' as const, verbs: ['Recycling'] };
    expect(withHostedDefaults({}, true, () => polywood)).toEqual({ 'claude-code': { spinnerVerbs: polywood } });
    expect(withHostedDefaults({}, false, () => polywood)).toEqual({});
    const mine = { 'claude-code': { spinnerVerbs: { mode: 'append' as const, verbs: ['Mine'] } } };
    expect(withHostedDefaults(mine, true, () => polywood)).toEqual(mine);
    expect(withHostedDefaults({ codex: { defaultModel: 'x' } }, true, () => polywood)).toMatchSnapshot();
  });
});
