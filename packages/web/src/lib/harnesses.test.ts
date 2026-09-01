import { expect, test } from 'vitest';
import { HARNESSES, defaultModeFor } from './harnesses';

const byId = (id: string) => HARNESSES.find((h) => h.id === id)!;

test('claude defaults to Pretty — the CLI view rewraps/drops replayed prose', () => {
  expect(defaultModeFor(byId('claude'))).toBe('pretty');
});

test('codex keeps its first listed mode (cli) as the default', () => {
  expect(defaultModeFor(byId('codex'))).toBe('cli');
});

test('single-mode harnesses fall through to their only mode', () => {
  expect(defaultModeFor(byId('grok'))).toBe('pretty');
  expect(defaultModeFor(byId('opencode'))).toBe('pretty');
  expect(defaultModeFor(byId('terminal'))).toBe('cli');
});
