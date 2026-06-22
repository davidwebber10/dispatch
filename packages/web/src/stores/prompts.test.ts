import { expect, test, beforeEach } from 'vitest';
import { usePrompts } from './prompts';

beforeEach(() => usePrompts.setState({ byTerminal: {} }));

test('stores a prompt from terminal:prompt', () => {
  usePrompts.getState().applyEvent({ type: 'terminal:prompt', terminalId: 't1', prompt: { kind: 'select', question: 'Pick', options: [{ label: 'A', keys: '\r' }], parsed: true } });
  expect(usePrompts.getState().byTerminal['t1']).toMatchObject({ kind: 'select', parsed: true });
});

test('clears a prompt when prompt is null', () => {
  const s = usePrompts.getState();
  s.applyEvent({ type: 'terminal:prompt', terminalId: 't1', prompt: { kind: 'confirm', question: 'x', options: [], parsed: true } });
  s.applyEvent({ type: 'terminal:prompt', terminalId: 't1', prompt: null });
  expect(usePrompts.getState().byTerminal['t1']).toBeNull();
});

test('ignores unrelated events', () => {
  usePrompts.getState().applyEvent({ type: 'terminal:status', terminalId: 't1', status: 'working' });
  expect(usePrompts.getState().byTerminal).toEqual({});
});
