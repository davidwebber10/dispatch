// packages/web/src/components/tabs/useStructuredStream.test.ts
import { renderHook, act } from '@testing-library/react';
import { test, expect, vi } from 'vitest';
import { useStructuredStream } from './useStructuredStream';
import * as sock from '../../api/structured-socket';

test('maps structured events into ConvItems', () => {
  let emit!: (e: any) => void;
  vi.spyOn(sock, 'openStructuredSocket').mockImplementation(({ onEvent }: any) => { emit = onEvent; return { close: () => {} }; });
  const { result } = renderHook(() => useStructuredStream('t1'));
  act(() => emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } }));
  act(() => emit({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] } }));
  act(() => emit({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'hmm' }] } }));
  act(() => emit({ type: 'user', message: { content: [{ type: 'tool_result', content: 'success', is_error: false }] } }));
  act(() => emit({ type: 'user', message: { content: [{ type: 'tool_result', content: 'failed', is_error: true }] } }));
  const items = result.current;
  expect(items.find((i) => i.kind === 'assistant' && i.text === 'hi')).toBeTruthy();
  expect(items.find((i) => i.kind === 'tool' && i.toolName === 'Bash')).toBeTruthy();
  expect(items.find((i) => i.kind === 'thinking' && i.text === 'hmm')).toBeTruthy();
  expect(items.find((i) => i.kind === 'tool-result' && i.text === 'success' && !i.isError)).toBeTruthy();
  expect(items.find((i) => i.kind === 'tool-result' && i.text === 'failed' && i.isError)).toBeTruthy();
});
