// Review of os.10: F5 (the box log filter covers the model fields) and F8 (an alias with a context suffix).
import { it, expect } from 'vitest';
import { boxLog, setBoxLogForTest } from '../os/box-log.js';
import { modelMatches } from './model-log.js';

it('F5: a key-shaped value in a model field is filtered like any other field; a model id is kept', () => {
  const lines: Record<string, unknown>[] = [];
  setBoxLogForTest({ enabled: true, sink: (l) => lines.push(JSON.parse(l)) });
  const tokenShaped = 'sk-ant-api03-' + 'A'.repeat(64);
  boxLog('thread.model', { requested: tokenShaped, reported: 'eyJhbGciOiJIUzI1NiJ9', model: 'claude-opus-5-5[1m]', serviceTier: 'priority', other: tokenShaped });
  setBoxLogForTest();
  const line = JSON.stringify(lines[0]);
  expect(line).not.toContain('sk-ant-api03');
  expect(line).not.toContain('eyJhbGci');
  expect(lines[0]).toMatchObject({ model: 'claude-opus-5-5[1m]', serviceTier: 'priority' });
});

it('F8: an alias with a context suffix matches its family with or without the suffix', () => {
  expect(modelMatches('opus[1m]', 'claude-opus-4-7[1m]')).toBe(true);
  expect(modelMatches('opus', 'claude-opus-4-7[1m]')).toBe(true);
  expect(modelMatches('sonnet[1m]', 'claude-opus-4-7[1m]')).toBe(false);
});
