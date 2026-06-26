import { it, expect, vi } from 'vitest';
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync: () => 'executor 1.5.20\n' };
});
import { IntegrationsService } from '../../src/integrations/service.js';

it('reports installed + version + a non-null executor spec when executor is present', () => {
  const svc = new IntegrationsService();
  const status = svc.status();
  expect(status.installed).toBe(true);
  // service.ts stores execFileSync output verbatim after .trim()
  expect(status.version).toBe('executor 1.5.20');
  const spec = svc.getServerSpec();
  expect(spec).toEqual({ name: 'executor', command: 'executor', args: ['mcp', '--elicitation-mode', 'model'] });
});
