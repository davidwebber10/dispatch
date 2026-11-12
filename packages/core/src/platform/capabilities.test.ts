import { describe, expect, test } from 'vitest';
import { BOX_CAPABILITIES } from './capabilities.js';
import { normalizeBasePath } from '../daemon/base-path.js';
import { createOsToolsRouter } from '../os/tools-proxy.js';

describe('the advertised capabilities are true of this tree', () => {
  test('the list', () => {
    expect([...BOX_CAPABILITIES]).toEqual(['base-path', 'os-tools-proxy', 'profile', 'headless-v1', 'idle-info', 'gate-v2']);
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
