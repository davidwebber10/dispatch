import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { openThreadInPlace } from './openThread';
import { useTabs } from '../../stores/tabs';
import { useOverseer } from '../overseer/store';

const origLoad = useTabs.getState().loadTabs;
const origDrill = useOverseer.getState().drillInto;

beforeEach(() => { useTabs.setState({ byProject: {} }); useOverseer.setState({ workerLightboxId: null }); });
afterEach(() => { useTabs.setState({ loadTabs: origLoad } as any); useOverseer.setState({ drillInto: origDrill } as any); });

describe('openThreadInPlace', () => {
  it('loads the project tabs first when they are not loaded, then opens the lightbox', async () => {
    const order: string[] = [];
    useTabs.setState({ loadTabs: vi.fn(async () => { order.push('load'); }) } as any);
    const drill = vi.fn((_id: string) => { order.push('drill'); });
    useOverseer.setState({ drillInto: drill } as any);
    await openThreadInPlace('s1', 't9');
    expect(order).toEqual(['load', 'drill']);
    expect(drill).toHaveBeenCalledWith('t9');
  });
  it('does not reload loaded tabs', async () => {
    useTabs.setState({ byProject: { s1: [] } });
    const load = vi.fn();
    useTabs.setState({ loadTabs: load } as any);
    await openThreadInPlace('s1', 't9');
    expect(load).not.toHaveBeenCalled();
    expect(useOverseer.getState().workerLightboxId).toBe('t9');
  });
});
