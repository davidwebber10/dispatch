import { describe, it, expect, vi, beforeEach } from 'vitest';
import { api } from './client';

describe('analytics api client', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ turns: 3 }) })));
  });

  it('passes the range as query parameters', async () => {
    await api.analyticsSummary({ from: '2026-08-01T00:00:00.000Z', projectId: 'p1' });
    const url = (globalThis.fetch as any).mock.calls[0][0] as string;
    expect(url).toContain('/api/analytics/summary?');
    expect(url).toContain('from=2026-08-01');
    expect(url).toContain('projectId=p1');
  });

  it('omits absent range fields instead of sending "undefined"', async () => {
    await api.analyticsSummary({});
    const url = (globalThis.fetch as any).mock.calls[0][0] as string;
    expect(url).not.toContain('undefined');
  });

  it('sends the metric and groupBy on a series request', async () => {
    await api.analyticsSeries({ metric: 'tokens', groupBy: 'model' });
    const url = (globalThis.fetch as any).mock.calls[0][0] as string;
    expect(url).toContain('metric=tokens');
    expect(url).toContain('groupBy=model');
  });
});
