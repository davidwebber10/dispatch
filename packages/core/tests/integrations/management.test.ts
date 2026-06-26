import { it, expect } from 'vitest';
import { IntegrationsService } from '../../src/integrations/service.js';

// Build a service with fake deps that records every `run` arg vector.
function harness(runImpl: (args: string[]) => string | Promise<string>) {
  const calls: string[][] = [];
  const deleted: string[] = [];
  const svc = new IntegrationsService({
    run: async (args: string[]) => { calls.push(args); return runImpl(args); },
    deleteCatalogEntry: async (slug: string) => { deleted.push(slug); return { removed: true }; },
  });
  return { svc, calls, deleted };
}

it('list() parses {ok,data} and maps integrations', async () => {
  const { svc } = harness(() => JSON.stringify({ ok: true, data: { integrations: [
    { slug: 'executor', description: 'Executor', kind: 'built-in', canRemove: false, canRefresh: false },
    { slug: 'petstore', description: 'Petstore', kind: 'openapi', canRemove: true, canRefresh: true },
  ] } }));
  const list = await svc.list();
  expect(list).toEqual([
    { slug: 'executor', description: 'Executor', kind: 'built-in', canRemove: false, canRefresh: false },
    { slug: 'petstore', description: 'Petstore', kind: 'openapi', canRemove: true, canRefresh: true },
  ]);
});

it('list() defaults missing fields safely', async () => {
  const { svc } = harness(() => JSON.stringify({ ok: true, data: { integrations: [{ slug: 'x' }] } }));
  expect(await svc.list()).toEqual([{ slug: 'x', description: '', kind: 'unknown', canRemove: false, canRefresh: false }]);
});

it('add(openapi) calls addSpec with url spec then creates a connection', async () => {
  const { svc, calls } = harness((args) =>
    args.includes('addSpec') ? JSON.stringify({ ok: true, data: { slug: 'my-api', toolCount: 5 } })
                             : JSON.stringify({ ok: true, data: {} }));
  const res = await svc.add({ type: 'openapi', url: 'https://x/openapi.json', slug: 'my-api' });
  expect(res).toEqual({ slug: 'my-api', toolCount: 5 });
  const addCall = calls.find((c) => c.includes('addSpec'))!;
  expect(addCall.slice(0, 4)).toEqual(['call', 'executor', 'openapi', 'addSpec']);
  expect(JSON.parse(addCall[4])).toEqual({ spec: { kind: 'url', url: 'https://x/openapi.json' }, slug: 'my-api' });
  const connCall = calls.find((c) => c.includes('connections') && c.includes('create'))!;
  expect(JSON.parse(connCall[5])).toEqual({ owner: 'org', name: 'default', integration: 'my-api', template: 'none' });
});

it('add(mcp-stdio) builds the stdio addServer payload', async () => {
  const { svc, calls } = harness((args) =>
    args.includes('addServer') ? JSON.stringify({ ok: true, data: { slug: 'my-mcp' } })
                               : JSON.stringify({ ok: true, data: {} }));
  const res = await svc.add({ type: 'mcp-stdio', name: 'My MCP', command: 'npx', args: ['-y', 'pkg'] });
  expect(res).toEqual({ slug: 'my-mcp', toolCount: undefined });
  expect(JSON.parse(calls.find((c) => c.includes('addServer'))![4]))
    .toEqual({ transport: 'stdio', name: 'My MCP', command: 'npx', args: ['-y', 'pkg'] });
});

it('add(mcp-remote) builds the remote addServer payload with optional slug', async () => {
  const { svc, calls } = harness((args) =>
    args.includes('addServer') ? JSON.stringify({ ok: true, data: { slug: 'remote-mcp' } })
                               : JSON.stringify({ ok: true, data: {} }));
  await svc.add({ type: 'mcp-remote', name: 'Remote', endpoint: 'https://x/mcp', slug: 'remote-mcp' });
  expect(JSON.parse(calls.find((c) => c.includes('addServer'))![4]))
    .toEqual({ transport: 'remote', name: 'Remote', endpoint: 'https://x/mcp', slug: 'remote-mcp' });
});

it('add(graphql) builds the addIntegration payload', async () => {
  const { svc, calls } = harness((args) =>
    args.includes('addIntegration') ? JSON.stringify({ ok: true, data: { slug: 'gql', name: 'GQL' } })
                                    : JSON.stringify({ ok: true, data: {} }));
  const res = await svc.add({ type: 'graphql', endpoint: 'https://x/graphql', slug: 'gql' });
  expect(res.slug).toBe('gql');
  expect(JSON.parse(calls.find((c) => c.includes('addIntegration'))![4]))
    .toEqual({ endpoint: 'https://x/graphql', slug: 'gql' });
});

it('add() still returns the slug when connection-create fails', async () => {
  const svc = new IntegrationsService({
    run: async (args: string[]) => {
      if (args.includes('addSpec')) return JSON.stringify({ ok: true, data: { slug: 'my-api', toolCount: 3 } });
      throw new Error('connection failed');
    },
    deleteCatalogEntry: async () => ({ removed: true }),
  });
  expect(await svc.add({ type: 'openapi', url: 'https://x', slug: 'my-api' })).toEqual({ slug: 'my-api', toolCount: 3 });
});

it('add() throws when executor returns ok:false', async () => {
  const { svc } = harness(() => JSON.stringify({ ok: false, error: 'bad spec' }));
  await expect(svc.add({ type: 'openapi', url: 'x', slug: 's' })).rejects.toThrow('bad spec');
});

it('remove() drops the connection (best-effort) then deletes the catalog entry', async () => {
  const { svc, calls, deleted } = harness(() => JSON.stringify({ ok: true, data: { removed: true } }));
  expect(await svc.remove('petstore')).toEqual({ removed: true });
  expect(calls.some((c) => c.includes('connections') && c.includes('remove'))).toBe(true);
  expect(deleted).toEqual(['petstore']);
});

it('remove() deletes the catalog entry even if connection-remove throws', async () => {
  let deleted = false;
  const svc = new IntegrationsService({
    run: async () => { throw new Error('no connection'); },
    deleteCatalogEntry: async () => { deleted = true; return { removed: true }; },
  });
  const r = await svc.remove('petstore');
  expect(deleted).toBe(true);
  expect(r.removed).toBe(true);
});
