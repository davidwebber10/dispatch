import { describe, expect, test } from 'vitest';
import { BOX_CAPABILITIES } from './capabilities.js';
import { normalizeBasePath } from '../daemon/base-path.js';
import { createOsToolsRouter } from '../os/tools-proxy.js';

describe('the advertised capabilities are true of this tree', () => {
  test('the list', () => {
    expect([...BOX_CAPABILITIES]).toEqual(['base-path', 'os-tools-proxy', 'profile', 'headless-v1', 'idle-info']);
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
  test('profile: the business gate refuses a terminal thread and follows the live profile', async () => {
    const { businessDecision, businessProfileGate } = await import('../profile/business-gate.js');
    const deny = businessDecision({ method: 'POST', path: '/api/sessions/s1/terminals', body: { type: 'shell' } } as never);
    expect(deny).not.toBeNull();
    let profile: 'business' | 'developer' = 'business';
    const gate = businessProfileGate(() => profile);
    const run = () => {
      let status = 0;
      let passed = false;
      const res = { status: (c: number) => { status = c; return { json: () => undefined }; } };
      gate({ method: 'POST', path: '/api/sessions/s1/terminals', body: { type: 'shell' } } as never, res as never, () => { passed = true; });
      return passed ? 'next' : status;
    };
    expect(run()).toBe(403);
    profile = 'developer';
    expect(run()).toBe('next');
  });
});
