import { expect, test, beforeEach } from 'vitest';
import { useActivity } from './activity';

beforeEach(() => useActivity.setState({ byTerminal: {} }));

test('captures terminal:activity payloads keyed by terminal id', () => {
  useActivity.getState().applyEvent({ type: 'terminal:activity', terminalId: 't1', activity: 'busy', model: 'Opus 4.8', cost: '$0.22', tokens: '20,312' });
  expect(useActivity.getState().byTerminal['t1']).toMatchObject({ model: 'Opus 4.8', cost: '$0.22', tokens: '20,312' });
});

test('ignores non-activity events', () => {
  useActivity.getState().applyEvent({ type: 'session:status', sessionId: 's1', status: 'working' });
  expect(useActivity.getState().byTerminal).toEqual({});
});
