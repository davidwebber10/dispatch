import { describe, expect, test } from 'vitest';
import { BOX_CAPABILITIES } from './capabilities.js';
import { normalizeBasePath } from '../daemon/base-path.js';
import { createOsToolsRouter } from '../os/tools-proxy.js';

describe('the advertised capabilities are true of this tree', () => {
  test('the list', () => {
    expect([...BOX_CAPABILITIES]).toEqual(['base-path', 'os-tools-proxy', 'profile', 'headless-v1', 'idle-info', 'gate-v2', 'inbox-v1', 'live-tools-v1', 'subagents-v1', 'codex-signout-v1']);
    // company-claude-v1 is a fact of the moment (os/login-policy.ts, login-policy.test.ts), like privsep-v1.
  });
  test('inbox-v1: the Inbox routes exist, each has a row in the business table, and the secret value is refused there', async () => {
    const { createInboxRouter } = await import('../routes/inbox.js');
    const { BUSINESS_ROUTES } = await import('../profile/business-routes.js');
    expect(typeof createInboxRouter).toBe('function');
    for (const id of [
      'GET /api/inbox', 'GET /api/inbox/unread', 'POST /api/inbox/read', 'GET /api/inbox/drops/:dropId',
      'POST /api/inbox/drops/:dropId/read', 'DELETE /api/inbox/drops/:dropId', 'GET /api/inbox/drops/:dropId/files/:fileId',
    ]) {
      expect(BUSINESS_ROUTES[id]?.business, id).toBe('allow');
      // No key kind is named: a thread's or a plugin's key is refused on these rows.
      expect(BUSINESS_ROUTES[id]?.keys, id).toBeUndefined();
    }
    expect(BUSINESS_ROUTES['GET /api/inbox/drops/:dropId/secret']?.business).toBe('refuse');
  });
  test('live-tools-v1: the event stream, the refresh signal and the refresh tool exist', async () => {
    const { REFRESH_TOOL_DEF, CONNECT_TOOL, OsToolCatalog } = await import('../os/tools-proxy.js');
    const { BUSINESS_ROUTES } = await import('../profile/business-routes.js');
    expect(REFRESH_TOOL_DEF.name).toBe('refresh');
    expect(CONNECT_TOOL).toBe('connect');
    expect(typeof OsToolCatalog.prototype.onToolsChanged).toBe('function');
    expect(BUSINESS_ROUTES['GET /api/os/mcp/:system']?.keys).toEqual(['thread']);
    expect(BUSINESS_ROUTES['POST /api/os/connections/refresh']?.keys).toBeUndefined();
  });
  test('subagents-v1: the subagent routes exist with rows in the business table, and both managers track subagents', async () => {
    const { createSubagentsRouter } = await import('../routes/subagents.js');
    const { BUSINESS_ROUTES } = await import('../profile/business-routes.js');
    const { ClaudeStructuredSessionManager } = await import('../structured/manager.js');
    const { CodexStructuredSessionManager } = await import('../structured/codex-manager.js');
    expect(typeof createSubagentsRouter).toBe('function');
    for (const id of [
      'GET /api/terminals/:terminalId/agents', 'GET /api/terminals/:terminalId/agents/:agentId/journal',
      'POST /api/terminals/:terminalId/agents/:agentId/stop', 'POST /api/terminals/:terminalId/agents/stop-all',
    ]) expect(BUSINESS_ROUTES[id]?.business, id).toBe('allow');
    for (const M of [ClaudeStructuredSessionManager, CodexStructuredSessionManager]) {
      expect(typeof M.prototype.listSubagents).toBe('function');
      expect(typeof M.prototype.stopSubagent).toBe('function');
      expect(typeof M.prototype.stopAllSubagents).toBe('function');
    }
  });
  test('company-claude-v1: the relay routes exist for thread keys only, and a company thread gets the relay env', async () => {
    const { createModelRelayRouter } = await import('../os/model-relay.js');
    const { companyClaudeEnv } = await import('../os/company-model.js');
    const { BUSINESS_ROUTES } = await import('../profile/business-routes.js');
    expect(typeof createModelRelayRouter).toBe('function');
    for (const id of ['POST /api/os-model/anthropic/v1/messages', 'POST /api/os-model/anthropic/v1/messages/count_tokens']) {
      expect(BUSINESS_ROUTES[id]?.keys, id).toEqual(['thread']);
    }
    expect(companyClaudeEnv('http://127.0.0.1:3456', 'dtk_x', 'claude-x').ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:3456/api/os-model/anthropic');
  });
  test('base-path', () => {
    expect(normalizeBasePath('/dispatch/')).toBe('/dispatch');
  });
  test('headless-v1: the one-call chat list exists', async () => {
    const { createChatsRouter } = await import('../routes/chats.js');
    expect(typeof createChatsRouter).toBe('function');
  });
  test('idle-info: the heartbeat carries automations', async () => {
    const { collectIdleInfo } = await import('../os/idle-info.js');
    expect(typeof collectIdleInfo).toBe('function');
  });
  test('os-tools-proxy', () => {
    expect(typeof createOsToolsRouter).toBe('function');
  });
  test('profile: the business guard refuses a terminal thread and follows the live profile', async () => {
    const { businessGuard, GATE_LOCAL } = await import('../profile/business-gate.js');
    const { BUSINESS_ROUTES } = await import('../profile/business-routes.js');
    let profile: 'business' | 'developer' = 'business';
    const route = {};
    const ids = new WeakMap<object, string>([[route, '/api/sessions/:id/terminals']]);
    const state = { profile: () => profile, table: BUSINESS_ROUTES, ids, facts: { thread: () => null, projectsRoot: () => '/nowhere' }, keyKind: () => null };
    const guard = businessGuard('POST');
    const run = () => {
      let status = 0;
      let passed = false;
      const res = { status: (c: number) => { status = c; return { json: () => undefined }; } };
      guard({ method: 'POST', route, params: { id: 's1' }, body: { type: 'shell' }, app: { locals: { [GATE_LOCAL]: state } } } as never, res as never, () => { passed = true; });
      return passed ? 'next' : status;
    };
    expect(run()).toBe(403);
    profile = 'developer';
    expect(run()).toBe('next');
  });
  test('gate-v2: a route with no row is refused for a business person, and a non-canonical path is refused for everyone', async () => {
    const { businessVerdict } = await import('../profile/business-gate.js');
    const { BUSINESS_ROUTES } = await import('../profile/business-routes.js');
    const { canonicalPathProblem } = await import('../http/canonical-path.js');
    const state = { profile: 'business' as const, table: BUSINESS_ROUTES, ids: new WeakMap<object, string>(), facts: { thread: () => null, projectsRoot: () => '/nowhere' }, keyKind: () => null };
    expect(businessVerdict(state, 'POST', '/api/a-route-nobody-classified', { params: {}, body: {} } as never)?.rule).toBe('unclassified');
    expect(businessVerdict(state, 'POST', undefined, { params: {}, body: {} } as never)?.rule).toBe('unclassified');
    expect(canonicalPathProblem('/api/sessions')).toBeNull();
    expect(canonicalPathProblem('/API/sessions')).toBe('prefix_case');
    expect(canonicalPathProblem('/api//sessions')).toBe('empty_segment');
  });
});
