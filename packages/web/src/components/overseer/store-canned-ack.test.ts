// The need-card acknowledgement is fixed text a click sends, not the user's own words. It must
// reach the daemon marked canned, so the overseer message log never stores it as 'user'.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useOverseer } from './store';
import { api } from '../../api/client';
import { CANNED } from './data';

beforeEach(() => {
  vi.restoreAllMocks();
  useOverseer.setState({ coordinatorId: 'coord-a', pendingByTerminal: {}, resolved: [] });
});

describe('needAction — canned acknowledgement', () => {
  it('sends the canned need acknowledgement with the canned marker', () => {
    const spy = vi.spyOn(api, 'sendStructuredMessage').mockResolvedValue(undefined as unknown as void);
    useOverseer.getState().needAction('agent-1', 'Deploy');
    expect(spy).toHaveBeenCalledWith('coord-a', CANNED.needAck('Deploy'), { canned: true });
    expect(useOverseer.getState().resolved).toContain('agent-1');
  });
});
