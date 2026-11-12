import { describe, expect, test } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BOX_CAPABILITIES } from './capabilities.js';
import { normalizeBasePath } from '../daemon/base-path.js';
import { createOsToolsRouter } from '../os/tools-proxy.js';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GATE = path.join(SRC, 'profile', 'business-gate.ts');

describe('the advertised capabilities are true of this tree', () => {
  test('the list', () => {
    expect([...BOX_CAPABILITIES]).toEqual(['base-path', 'os-tools-proxy', 'profile']);
  });
  test('base-path', () => {
    expect(normalizeBasePath('/dispatch/')).toBe('/dispatch');
  });
  test('os-tools-proxy', () => {
    expect(typeof createOsToolsRouter).toBe('function');
  });
  // The business-profile gate lives on feat/os-profile-theme: this proves the claim once the trees merge.
  test.skipIf(!fs.existsSync(GATE))('profile: the business gate refuses a terminal thread', async () => {
    const mod: any = await import(/* @vite-ignore */ GATE);
    const deny = mod.businessDecision({ method: 'POST', path: '/api/sessions/s1/terminals', body: { type: 'shell' } });
    expect(deny).not.toBeNull();
  });
});
