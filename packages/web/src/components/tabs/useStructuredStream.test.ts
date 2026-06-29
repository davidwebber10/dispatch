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
  const items = result.current;
  expect(items.find((i) => i.kind === 'assistant' && i.text === 'hi')).toBeTruthy();
  expect(items.find((i) => i.kind === 'tool' && i.toolName === 'Bash')).toBeTruthy();
});
