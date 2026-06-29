import { describe, it, expect, vi, beforeEach } from 'vitest';

const reorderTerminals = vi.fn();
const listTerminals = vi.fn();
vi.mock('../api/client', () => ({ api: {
  reorderTerminals: (sid: string, order: string[]) => reorderTerminals(sid, order),
  listTerminals: (sid: string) => listTerminals(sid),
} }));

import { useTabs } from './tabs';

const mk = (id: string) => ({ id, sessionId: 'p', type: 'claude-code', label: id, status: 'waiting' } as any);

describe('useTabs.reorder', () => {
  beforeEach(() => {
    reorderTerminals.mockReset(); listTerminals.mockReset();
    useTabs.setState({ byProject: { p: [mk('a'), mk('b'), mk('c')] } } as any);
  });

  it('optimistically reorders byProject and calls the API', async () => {
    reorderTerminals.mockResolvedValue(undefined);
    await useTabs.getState().reorder('p', ['c', 'a', 'b']);
    expect(useTabs.getState().byProject.p.map((t) => t.id)).toEqual(['c', 'a', 'b']);
    expect(reorderTerminals).toHaveBeenCalledWith('p', ['c', 'a', 'b']);
  });

  it('reloads from the server when the API rejects', async () => {
    reorderTerminals.mockRejectedValue(new Error('nope'));
    listTerminals.mockResolvedValue([mk('a'), mk('b'), mk('c')]);
    await useTabs.getState().reorder('p', ['c', 'a', 'b']);
    expect(listTerminals).toHaveBeenCalledWith('p');
    expect(useTabs.getState().byProject.p.map((t) => t.id)).toEqual(['a', 'b', 'c']);
  });
});
