// Composer state scoping — regression test for the cross-project draft/image leak:
// with multiple Dispatch tabs open (one per project), staged state must never bleed
// from one project into another. Draft TEXT itself lives outside the store (see
// Composer.tsx's useDraft(coordinatorProject)); this file covers the store-owned
// piece, composerImagesByProject, plus sendDirective's per-project image scoping.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useOverseer, coordinatorMatchesView, viewCoordinatorFields } from './store';
import { api } from '../../api/client';
import type { StreamMessage } from './types';

const img = (data: string) => ({ type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png' as const, data } });

beforeEach(() => {
  vi.restoreAllMocks();
  useOverseer.setState({
    coordinatorProject: null,
    coordinatorId: null,
    composerImagesByProject: {},
    sendError: null,
  });
});

describe('composer image staging — scoped per coordinator project', () => {
  it('addComposerImage buffers under the CURRENT project only, leaving other projects untouched', () => {
    useOverseer.setState({ coordinatorProject: 'proj-a' });
    useOverseer.getState().addComposerImage(img('a1'));

    useOverseer.setState({ coordinatorProject: 'proj-b' });
    useOverseer.getState().addComposerImage(img('b1'));

    const { composerImagesByProject } = useOverseer.getState();
    expect(composerImagesByProject['proj-a']).toEqual([img('a1')]);
    expect(composerImagesByProject['proj-b']).toEqual([img('b1')]);
  });

  it('removeComposerImage only drops from the current project\'s buffer', () => {
    useOverseer.setState({ composerImagesByProject: { 'proj-a': [img('a1'), img('a2')], 'proj-b': [img('b1')] } });
    useOverseer.setState({ coordinatorProject: 'proj-a' });
    useOverseer.getState().removeComposerImage(0);

    const { composerImagesByProject } = useOverseer.getState();
    expect(composerImagesByProject['proj-a']).toEqual([img('a2')]);
    expect(composerImagesByProject['proj-b']).toEqual([img('b1')]); // untouched
  });

  it('sendDirective clears only the sending project\'s staged images', async () => {
    vi.spyOn(api, 'sendStructuredMessage').mockResolvedValue(undefined as unknown as void);
    useOverseer.setState({
      coordinatorProject: 'proj-a',
      coordinatorId: 'coord-a',
      composerImagesByProject: { 'proj-a': [img('a1')], 'proj-b': [img('b1')] },
    });

    useOverseer.getState().sendDirective('hello from a');

    expect(api.sendStructuredMessage).toHaveBeenCalledWith('coord-a', [img('a1'), { type: 'text', text: 'hello from a' }]);
    const { composerImagesByProject } = useOverseer.getState();
    expect(composerImagesByProject['proj-a']).toEqual([]); // sent → cleared
    expect(composerImagesByProject['proj-b']).toEqual([img('b1')]); // other project untouched
  });

  it('sendDirective no-ops with no coordinator id, without touching staged images', () => {
    useOverseer.setState({ coordinatorProject: 'proj-a', coordinatorId: null, composerImagesByProject: { 'proj-a': [img('a1')] } });
    const spy = vi.spyOn(api, 'sendStructuredMessage');

    useOverseer.getState().sendDirective('unsendable');

    expect(spy).not.toHaveBeenCalled();
    expect(useOverseer.getState().composerImagesByProject['proj-a']).toEqual([img('a1')]);
  });
});

const sm = (key: string): StreamMessage =>
  ({ kind: 'text', who: 'overseer', text: key, time: '', key, isUser: false, isOverseer: true, isNote: false } as unknown as StreamMessage);

describe('coordinatorMatchesView — the loaded coordinator belongs to the viewed project', () => {
  it('true only when both ids are set and equal', () => {
    expect(coordinatorMatchesView('proj-a', 'proj-a')).toBe(true);
    expect(coordinatorMatchesView('proj-a', 'proj-b')).toBe(false);
    expect(coordinatorMatchesView(null, 'proj-a')).toBe(false);
    expect(coordinatorMatchesView('proj-a', null)).toBe(false);
    expect(coordinatorMatchesView(null, null)).toBe(false);
  });
});

describe('viewCoordinatorFields — a stale-project coordinator is never surfaced', () => {
  const stream = [sm('a1'), sm('a2')];

  it('passes the coordinator fields through when the project matches', () => {
    const out = viewCoordinatorFields({ coordinatorProject: 'proj-a', activeId: 'proj-a', coordinatorStream: stream, coordinatorBusy: true, coordinatorId: 'coord-a' });
    expect(out.projectMatches).toBe(true);
    expect(out.stream).toBe(stream);
    expect(out.busy).toBe(true);
    expect(out.hasCoordinator).toBe(true);
  });

  it('blanks the stream/busy/hasCoordinator when the store holds ANOTHER project', () => {
    const out = viewCoordinatorFields({ coordinatorProject: 'proj-a', activeId: 'proj-b', coordinatorStream: stream, coordinatorBusy: true, coordinatorId: 'coord-a' });
    expect(out.projectMatches).toBe(false);
    expect(out.stream).toEqual([]);
    expect(out.busy).toBe(false);
    expect(out.hasCoordinator).toBe(false);
  });
});
