import { describe, expect, test } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  instructionsHome, rewriteInstructions,
  localToolName, osServerNames, osServerSpecs, osServersNote, realToolName, resolveOsServerNames, serverNameFor, toolSystem,
} from './os-servers.js';
import { composeInjection, type McpServerSpec } from '../mcp/injection.js';
import { writeOpencodeConfig } from '../providers/opencode-config.js';
import { finalizeOsServers } from '../sessions/spawn-injection.js';

const API = 'http://127.0.0.1:3999/dispatch';
const specs = () => osServerSpecs({ daemonApi: API, systems: ['acumatica', 'google_drive', 'os'], bridgePath: '/app/os-mcp-bridge.js' });

describe('naming', () => {
  test('server names: system id, `_` -> `-`, OS own system is `connections`', () => {
    expect(serverNameFor('acumatica')).toBe('acumatica');
    expect(serverNameFor('google_drive')).toBe('google-drive');
    expect(serverNameFor('os')).toBe('connections');
  });
  test('tool names drop the system prefix and map back', () => {
    expect(localToolName('acumatica', 'acumatica_search_sales_orders')).toBe('search_sales_orders');
    expect(localToolName('google_drive', 'google_drive_search')).toBe('search');
    expect(localToolName('os', 'os_list_connections')).toBe('list');
    expect(realToolName('acumatica', 'search_sales_orders')).toBe('acumatica_search_sales_orders');
    expect(realToolName('os', 'list')).toBe('os_list_connections');
    // The catalog wins over the prefix rule (a tool OS named without the prefix).
    expect(realToolName('zendesk', 'odd', ['odd'])).toBe('odd');
  });
  test('a tool system: its field, else the longest known prefix', () => {
    expect(toolSystem({ name: 'x_y', system: 'acumatica' })).toBe('acumatica');
    expect(toolSystem({ name: 'x_y', _meta: { system: 'zendesk' } })).toBe('zendesk');
    expect(toolSystem({ name: 'google_drive_search' }, ['google', 'google_drive'])).toBe('google_drive');
    expect(toolSystem({ name: 'shopify_search_orders' })).toBe('shopify');
  });
});

describe('collisions', () => {
  test("the person's server keeps its name; the OS one becomes os-<name>", () => {
    const mine: McpServerSpec = { name: 'acumatica', command: 'node', args: ['mine.js'] };
    const out = resolveOsServerNames([mine, ...specs()]);
    expect(out.map((s) => s.name)).toEqual(['acumatica', 'os-acumatica', 'google-drive', 'connections']);
    expect(out[1].http?.url).toBe(`${API}/api/os/mcp/acumatica`); // the route still names the system
    // A name from the person's own Claude config counts too.
    expect(resolveOsServerNames(specs(), ['connections']).map((s) => s.name)).toEqual(['acumatica', 'google-drive', 'os-connections']);
    expect(osServerNames(out)).toEqual(['os-acumatica', 'google-drive', 'connections']);
  });
  test('finalizeOsServers renames in place and adds one note', () => {
    const list: McpServerSpec[] = [{ name: 'google-drive', command: 'x', args: [] }, ...specs()];
    const prompts: string[] = [];
    finalizeOsServers(list, prompts, []);
    expect(list.map((s) => s.name)).toEqual(['google-drive', 'acumatica', 'os-google-drive', 'connections']);
    expect(prompts).toEqual([osServersNote(list, 'POLYWOOD OS')]);
    expect(prompts[0]).toContain('acumatica, os-google-drive');
    expect(prompts[0]).not.toContain('os-tools');
  });
});

describe('harness configs (snapshots)', () => {
  const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'os-servers-'));
  test('Claude Code: loopback HTTP entries, the key as a reference', () => {
    const d = dir();
    const inj = composeInjection(specs(), { configPath: path.join(d, 'c.json'), prompts: [] });
    expect(JSON.parse(fs.readFileSync(inj.claudeConfigPath!, 'utf8'))).toMatchInlineSnapshot(`
      {
        "mcpServers": {
          "acumatica": {
            "headers": {
              "Authorization": "Bearer \${DISPATCH_AUTH}",
            },
            "type": "http",
            "url": "http://127.0.0.1:3999/dispatch/api/os/mcp/acumatica",
          },
          "connections": {
            "headers": {
              "Authorization": "Bearer \${DISPATCH_AUTH}",
            },
            "type": "http",
            "url": "http://127.0.0.1:3999/dispatch/api/os/mcp/os",
          },
          "google-drive": {
            "headers": {
              "Authorization": "Bearer \${DISPATCH_AUTH}",
            },
            "type": "http",
            "url": "http://127.0.0.1:3999/dispatch/api/os/mcp/google_drive",
          },
        },
      }
    `);
  });
  test('Codex CLI: url + bearer_token_env_var; Codex Pretty: the literal in the piped thread config', () => {
    const d = dir();
    const cli = composeInjection(specs().slice(0, 1), { configPath: path.join(d, 'c.json'), prompts: [] });
    expect(cli.codexArgs).toEqual([
      '-c', 'mcp_servers.acumatica.url="http://127.0.0.1:3999/dispatch/api/os/mcp/acumatica"',
      '-c', 'mcp_servers.acumatica.bearer_token_env_var="DISPATCH_AUTH"',
    ]);
    const pretty = composeInjection(specs().slice(0, 1), { configPath: path.join(d, 'p.json'), prompts: [], codexAuthLiteral: 'dtk_x' });
    expect(pretty.codexThreadConfig).toEqual({ 'mcp_servers.acumatica': { url: 'http://127.0.0.1:3999/dispatch/api/os/mcp/acumatica', http_headers: { Authorization: 'Bearer dtk_x' } } });
  });
  test('OpenCode: a remote entry with {env:DISPATCH_AUTH}; smart rules name the systems', () => {
    const d = dir();
    const entries = { acumatica: { url: `${API}/api/os/mcp/acumatica`, headers: { Authorization: 'Bearer {env:DISPATCH_AUTH}' } } };
    const p = writeOpencodeConfig({ dir: d, mcpServers: entries, smart: true, osServers: ['acumatica'] });
    const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
    expect(cfg.mcp).toEqual({ acumatica: { type: 'remote', url: `${API}/api/os/mcp/acumatica`, enabled: true, headers: { Authorization: 'Bearer {env:DISPATCH_AUTH}' } } });
    expect(cfg.permission['acumatica_*search*']).toBe('allow');
  });
  test('Grok (and the Codex CLI view): the stdio bridge, one per system', () => {
    const d = dir();
    const inj = composeInjection(specs().slice(0, 1), { configPath: path.join(d, 'c.json'), prompts: [], authVar: 'DISPATCH_AUTH_FILE' });
    expect(JSON.parse(fs.readFileSync(inj.claudeConfigPath!, 'utf8')).mcpServers.acumatica).toEqual({
      command: 'node', args: ['/app/os-mcp-bridge.js'], env: { DISPATCH_API: API, DISPATCH_OS_SYSTEM: 'acumatica', DISPATCH_AUTH_FILE: '${DISPATCH_AUTH_FILE}' },
    });
  });
});

describe('the gateway instructions', () => {
  const HEAD = 'Tool names here are written <server>_<tool>: data_query is the `query` tool on\nthe `data` server. Call data_guide first. Show charts with display_chart.\nCall os_list_connections to see what is connected. Keep data_freshness notes. [[chart:<id>]]';
  const tools = { data: ['data_query', 'data_guide'], display: ['display_chart'], os: ['os_list_connections'] };
  test('gateway names become <server>.<tool>; unknown words and markers stay', () => {
    expect(rewriteInstructions(HEAD, tools)).toBe('Tool names here are written <server>.<tool>: data.query is the `query` tool on\nthe `data` server. Call data.guide first. Show charts with display.chart.\nCall connections.list to see what is connected. Keep data_freshness notes. [[chart:<id>]]');
    // A renamed server (a collision) is written with the name the thread sees.
    expect(rewriteInstructions('Call data_guide.', tools, (s) => (s === 'data' ? 'os-data' : s))).toBe('Call os-data.guide.');
  });
  test('they ride the data server, else connections', () => {
    expect(instructionsHome(['acumatica', 'data', 'display', 'os'])).toBe('data');
    expect(instructionsHome(['acumatica', 'os'])).toBe('os');
  });
  test('a harness that drops MCP instructions gets them in its prompt; Claude Code does not', () => {
    const info = { instructions: 'Call data_guide first.', tools: new Map([['data', ['data_guide']], ['os', ['os_list_connections']]]) };
    const mk = () => osServerSpecs({ daemonApi: API, systems: ['data', 'os'], bridgePath: '/b.js' });
    const p1: string[] = [];
    finalizeOsServers(mk(), p1, [], 'opencode', info);
    expect(p1).toContain('Call data.guide first.');
    const p2: string[] = [];
    finalizeOsServers(mk(), p2, [], 'claude-code', info);
    expect(p2.join('\n')).not.toContain('guide first');
  });
});
