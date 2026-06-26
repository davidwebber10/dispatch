import { describe, it, expect, vi } from 'vitest';
vi.mock('node:child_process', () => ({ execFileSync: () => { throw new Error('not installed'); } }));
import { IntegrationsService } from '../../src/integrations/service.js';

it('reports not installed + null spec when executor is absent', () => {
  const svc = new IntegrationsService();
  expect(svc.status().installed).toBe(false);
  expect(svc.getServerSpec()).toBeNull();
});
