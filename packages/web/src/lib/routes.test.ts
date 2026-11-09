import { describe, it, expect } from 'vitest';
import { parseRoute, routeHref, sameRoute, type Route } from './routes';

const EVERY: [Route, string][] = [
  [{ view: 'workspace' }, '/'],
  [{ view: 'workspace', projectId: 'p1' }, '/p/p1'],
  [{ view: 'workspace', projectId: 'p1', threadId: 't1' }, '/p/p1/t/t1'],
  [{ view: 'workspace', projectId: 'p1', agentId: 'a1' }, '/p/p1/a/a1'],
  [{ view: 'settings' }, '/settings'],
  [{ view: 'settings', section: 'secrets' }, '/settings/secrets'],
  [{ view: 'settings', section: 'plugins', subPage: 'previews' }, '/settings/plugins/previews'],
  [{ view: 'chat' }, '/chat'],
  [{ view: 'analytics' }, '/analytics'],
  [{ view: 'plugin:previews:history' }, '/x/previews:history'],
];

describe('routes', () => {
  it('parse and href are inverse for every route kind', () => {
    for (const [route, path] of EVERY) {
      expect(routeHref(route, '')).toBe(path);
      expect(parseRoute(path, '')).toEqual(route);
      expect(parseRoute(routeHref(route, ''), '')).toEqual(route);
    }
  });

  it('an id with a character that is not safe in a path survives the round trip', () => {
    const route: Route = { view: 'workspace', projectId: 'a b/c', threadId: 'x?y#z' };
    const path = routeHref(route, '');
    expect(path).toBe('/p/a%20b%2Fc/t/x%3Fy%23z');
    expect(parseRoute(path, '')).toEqual(route);
  });

  it('a base path prefix is removed and added', () => {
    const base = '/u/dw/dispatch';
    for (const [route, path] of EVERY) {
      expect(routeHref(route, base)).toBe(path === '/' ? `${base}/` : base + path);
      expect(parseRoute(routeHref(route, base), base)).toEqual(route);
    }
    // A trailing slash on the base, and the mount point itself without a slash.
    expect(parseRoute('/u/dw/dispatch', '/u/dw/dispatch/')).toEqual({ view: 'workspace' });
    expect(routeHref({ view: 'chat' }, '/u/dw/dispatch/')).toBe('/u/dw/dispatch/chat');
    // A path that only starts with the same letters is not under the base.
    expect(parseRoute('/u/dw/dispatcher/chat', base)).toEqual({ view: 'workspace' });
  });

  it('an unknown path parses as the workspace root', () => {
    for (const path of ['/nope', '/p', '/p/', '/p/p1/q/zz', '/settingsx', '/x', '/api/sessions', '', '/chat/extra', '/p/%E0%A4%A/t/t1']) {
      expect(parseRoute(path, '')).toEqual({ view: 'workspace' });
    }
  });

  it('a trailing slash is ignored', () => {
    expect(parseRoute('/p/p1/t/t1/', '')).toEqual({ view: 'workspace', projectId: 'p1', threadId: 't1' });
    expect(parseRoute('/settings/', '')).toEqual({ view: 'settings' });
  });

  it('the phone agent path parses', () => {
    expect(parseRoute('/p/s1/a/sched-9', '')).toEqual({ view: 'workspace', projectId: 's1', agentId: 'sched-9' });
  });

  it('sameRoute compares by address', () => {
    expect(sameRoute({ view: 'workspace', projectId: 'p1' }, { view: 'workspace', projectId: 'p1', threadId: undefined })).toBe(true);
    expect(sameRoute({ view: 'workspace', projectId: 'p1' }, { view: 'workspace', projectId: 'p2' })).toBe(false);
    expect(sameRoute({ view: 'settings' }, { view: 'chat' })).toBe(false);
  });
});
