import { describe, it, expect, vi, afterEach } from 'vitest';
import { callTool, handleRequest, TOOLS } from '../../src/endless/memory-mcp.js';

afterEach(() => vi.unstubAllGlobals());

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('memory MCP server', () => {
  it('lists exactly the stage-1 tools with fixed descriptions', async () => {
    const res = await handleRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect((res!.result as any).tools.map((t: any) => t.name)).toEqual(['zoom', 'date', 'list_threads', 'read_thread']);
    expect(TOOLS[0].description).toBe('Open the line id+n of the view into the two lines of n/2 under it; n = 1 gives the message whole.');
    expect(TOOLS[1].description).toBe('The date and time of message id.');
  });

  it('zoom returns text and image content blocks', async () => {
    const fetchMock = vi.fn(async () => json(200, { text: '#0 user: hi', images: [{ mimeType: 'image/png', data: 'AAA=' }] }));
    vi.stubGlobal('fetch', fetchMock);
    const r = await callTool('zoom', { id: 0, n: 1 });
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toMatch(/\/api\/endless\/zoom\?id=0&n=1$/);
    expect(r.content).toEqual([{ type: 'text', text: '#0 user: hi' }, { type: 'image', data: 'AAA=', mimeType: 'image/png' }]);
    expect(r.isError).toBeUndefined();
  });

  it('reports a daemon error as an MCP error, never a crash', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(400, { error: 'n must be a power of 2 and id a multiple of n' })));
    const r = await callTool('zoom', { id: 0, n: 3 });
    expect(r.isError).toBe(true);
    expect((r.content[0] as any).text).toMatch(/power of 2/);
  });

  it('read_thread joins the assistant output and lists the tools', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(200, { items: [
      { kind: 'assistant', text: 'one' }, { kind: 'tool', toolName: 'Bash' }, { kind: 'assistant', text: 'two' },
    ] })));
    const r = await callTool('read_thread', { id: 't1' });
    expect(JSON.parse((r.content[0] as any).text)).toEqual({ id: 't1', output: 'one\n\ntwo', tools: ['Bash'] });
  });
});
