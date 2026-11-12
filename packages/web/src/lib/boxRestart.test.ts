import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isBoxDownAnswer, noteBoxDown, resetBoxRestart, useBoxRestart, reloadTarget } from './boxRestart';

const res = (status: number, body: string, type = 'application/json', extra: Partial<Response> = {}) =>
  Object.assign(new Response(body, { status, headers: { 'content-type': type } }), extra);

describe('a hosted box restarting', () => {
  beforeEach(() => resetBoxRestart());

  it('the router\'s 503 {error,state}, a 502, a redirect and the launcher HTML are "down"; the daemon\'s own 503 is not', async () => {
    expect(await isBoxDownAnswer(res(503, '{"error":"box not ready","state":"starting"}'))).toBe(true);
    expect(await isBoxDownAnswer(res(502, ''))).toBe(true);
    expect(await isBoxDownAnswer(res(200, '<html>launcher</html>', 'text/html'))).toBe(true);
    expect(await isBoxDownAnswer(res(503, '{"error":"chat is off"}'))).toBe(false);
    expect(await isBoxDownAnswer(res(404, '{"error":"nope"}'))).toBe(false);
  });

  it('polls without following redirects and reloads ONCE at the base path with the slash', async () => {
    let up = false;
    const fetchImpl = vi.fn(async (_u: string, init: any) => {
      expect(init.redirect).toBe('manual');
      return up ? res(200, '{"kind":"owner"}') : res(503, '{"state":"starting"}');
    });
    const reload = vi.fn();
    noteBoxDown({ fetchImpl: fetchImpl as any, reload, pollMs: 5 });
    noteBoxDown({ fetchImpl: fetchImpl as any, reload, pollMs: 5 }); // a second failure does not start a second poll
    expect(useBoxRestart.getState().down).toBe(true);
    await new Promise((r) => setTimeout(r, 30));
    expect(reload).not.toHaveBeenCalled();
    up = true;
    await new Promise((r) => setTimeout(r, 40));
    expect(reload).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledWith(reloadTarget());
    expect(reloadTarget().endsWith('/')).toBe(true);
  });
});
