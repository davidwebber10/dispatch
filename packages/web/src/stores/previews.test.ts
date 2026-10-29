import { describe, it, expect, beforeEach, vi } from 'vitest';
import { usePreviews, unseenPreviews } from './previews';
import { api } from '../api/client';
import type { Preview } from '../api/types';

const p = (id: string, over: Partial<Preview> = {}): Preview => ({
  id, sessionId: 's1', sessionName: 'Alpha', terminalId: 't1', terminalLabel: 'Worker', title: id, note: null, text: null, files: [],
  createdAt: `2026-10-28T10:0${id.length}:00.000Z`, seenAt: null, ...over,
});

beforeEach(() => {
  usePreviews.setState({ items: [], loaded: false, loading: false, sheet: null });
  vi.restoreAllMocks();
});

describe('usePreviews', () => {
  it('loads newest first and counts unseen per project and overall', async () => {
    vi.spyOn(api, 'listPreviews').mockResolvedValue({ previews: [p('a'), p('bb', { sessionId: 's2', seenAt: 'x' }), p('ccc')], unseen: 2 });
    await usePreviews.getState().load();
    expect(usePreviews.getState().items.map((x) => x.id)).toEqual(['ccc', 'bb', 'a']);
    expect(unseenPreviews(usePreviews.getState().items)).toBe(2);
    expect(unseenPreviews(usePreviews.getState().items, 's1')).toBe(2);
    expect(unseenPreviews(usePreviews.getState().items, 's2')).toBe(0);
  });

  it('a preview:new event puts the item first; preview:changed marks seen or removes', () => {
    usePreviews.setState({ items: [p('a')] });
    usePreviews.getState().applyEvent({ type: 'preview:new', preview: p('b') });
    expect(usePreviews.getState().items.map((x) => x.id)).toEqual(['b', 'a']);
    usePreviews.getState().applyEvent({ type: 'preview:changed', id: 'a', sessionId: 's1', seenAt: '2026-10-28T11:00:00.000Z' });
    expect(usePreviews.getState().items.find((x) => x.id === 'a')?.seenAt).toBe('2026-10-28T11:00:00.000Z');
    usePreviews.getState().applyEvent({ type: 'preview:changed', id: 'b', sessionId: 's1', deleted: true });
    expect(usePreviews.getState().items.map((x) => x.id)).toEqual(['a']);
  });

  it('markAllSeen marks the project\'s unseen items at once and calls the API for each', async () => {
    const seen = vi.spyOn(api, 'markPreviewSeen').mockResolvedValue(p('x'));
    usePreviews.setState({ items: [p('a'), p('b', { sessionId: 's2' }), p('c', { seenAt: 'x' })] });
    await usePreviews.getState().markAllSeen('s1');
    expect(seen).toHaveBeenCalledTimes(1);
    expect(seen).toHaveBeenCalledWith('a');
    expect(unseenPreviews(usePreviews.getState().items)).toBe(1); // b, in s2
  });

  it('remove drops the item and puts it back when the delete fails', async () => {
    vi.spyOn(api, 'deletePreview').mockRejectedValue(new Error('down'));
    usePreviews.setState({ items: [p('a')] });
    await usePreviews.getState().remove('a');
    expect(usePreviews.getState().items).toHaveLength(1);
  });

  it('the sheet opens for a project and closes', () => {
    usePreviews.getState().openSheet('s1');
    expect(usePreviews.getState().sheet).toBe('s1');
    usePreviews.getState().closeSheet();
    expect(usePreviews.getState().sheet).toBeNull();
  });
});
