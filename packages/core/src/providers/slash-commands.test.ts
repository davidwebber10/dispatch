import { describe, it, expect } from 'vitest';
import {
  parseSlash, slashCommandsFor, validateThreadSettings, resolveModelArg, resolveEffortArg, EFFORT_LEVELS,
} from './slash-commands.js';

describe('parseSlash', () => {
  it('reads a command word with and without arguments', () => {
    expect(parseSlash('/model')).toEqual({ name: 'model', args: '', known: true });
    expect(parseSlash('/model opus')).toEqual({ name: 'model', args: 'opus', known: true });
    expect(parseSlash('/effort   high  ')).toEqual({ name: 'effort', args: 'high', known: true });
    expect(parseSlash('/Compact')).toEqual({ name: 'compact', args: '', known: true });
  });
  it('flags an unknown word, without treating it as a command', () => {
    expect(parseSlash('/frobnicate now')).toEqual({ name: 'frobnicate', args: 'now', known: false });
  });
  it('is not a slash word when the text has a leading space (the escape) or is a path', () => {
    expect(parseSlash(' /model opus')).toBeNull();
    expect(parseSlash('/usr/local/bin is on my path')).toBeNull();
    expect(parseSlash('/')).toBeNull();
    expect(parseSlash('//model')).toBeNull();
    expect(parseSlash('hello /model')).toBeNull();
    expect(parseSlash('')).toBeNull();
  });
  it('keeps multi-line arguments out of the command word', () => {
    expect(parseSlash('/model opus\nand more')).toEqual({ name: 'model', args: 'opus\nand more', known: true });
  });
});

describe('slashCommandsFor', () => {
  const names = (surface: any, harness: any) => slashCommandsFor(surface, harness).map((c) => c.name);
  it('lists the thread commands for Claude and Codex, enabled', () => {
    for (const h of ['claude-code', 'codex'] as const) {
      const cmds = slashCommandsFor('thread', h);
      expect(cmds.map((c) => c.name)).toEqual(['model', 'effort', 'compact', 'stop', 'cli', 'restart']);
      expect(cmds.every((c) => !c.disabledReason)).toBe(true);
    }
  });
  it('greys model, effort and compact for Grok and OpenCode with a reason, and drops /cli', () => {
    for (const h of ['grok', 'opencode'] as const) {
      const cmds = slashCommandsFor('thread', h);
      expect(cmds.find((c) => c.name === 'model')!.disabledReason).toMatch(/not yet/i);
      expect(cmds.find((c) => c.name === 'effort')!.disabledReason).toBeTruthy();
      expect(cmds.find((c) => c.name === 'compact')!.disabledReason).toBeTruthy();
      expect(cmds.find((c) => c.name === 'stop')!.disabledReason).toBeUndefined();
      expect(cmds.find((c) => c.name === 'cli')).toBeUndefined();
    }
  });
  it('has no /cli or /restart on an overseer, and only model, effort, stop in Chat', () => {
    expect(names('overseer', 'claude-code')).toEqual(['model', 'effort', 'compact', 'stop']);
    expect(names('chat', 'claude-code')).toEqual(['model', 'effort', 'stop']);
  });
  it('takes arguments only for model and effort', () => {
    const cmds = slashCommandsFor('thread', 'claude-code');
    expect(cmds.filter((c) => c.takesArgs).map((c) => c.name)).toEqual(['model', 'effort']);
  });
});

describe('resolveModelArg / resolveEffortArg', () => {
  it('matches a model by label or id, case-insensitive', () => {
    expect(resolveModelArg('claude-code', 'Opus')).toEqual({ model: 'opus' });
    expect(resolveModelArg('claude-code', 'default')).toEqual({ model: null });
    expect(resolveModelArg('codex', '6 astra')).toEqual({ model: 'gpt-6-astra' });
    expect(resolveModelArg('codex', 'gpt-5.6-sol')).toEqual({ model: 'gpt-5.6-sol' });
  });
  it('lists the choices for an unknown model', () => {
    const r = resolveModelArg('claude-code', 'banana');
    expect(r).toHaveProperty('error');
    expect((r as any).error).toMatch(/opus/);
  });
  it('matches an effort level', () => {
    expect(resolveEffortArg('claude-code', 'HIGH')).toEqual({ effort: 'high' });
    expect(resolveEffortArg('codex', 'xhigh')).toEqual({ effort: 'xhigh' });
    expect((resolveEffortArg('claude-code', 'bogus') as any).error).toMatch(/low, medium, high, xhigh, max/);
    expect((resolveEffortArg('grok', 'high') as any).error).toBeTruthy();
  });
});

describe('validateThreadSettings', () => {
  it('accepts a Claude alias, a full id, a reset and a known effort', () => {
    expect(validateThreadSettings('claude-code', { model: 'opus', effort: 'max' })).toBeNull();
    expect(validateThreadSettings('claude-code', { model: 'claude-opus-5-5[1m]' })).toBeNull();
    expect(validateThreadSettings('claude-code', { model: null })).toBeNull();
    expect(validateThreadSettings('claude-code', { effort: 'low' })).toBeNull();
  });
  it('refuses a model from the other harness', () => {
    expect(validateThreadSettings('claude-code', { model: 'gpt-6-astra' })).toMatch(/Claude/);
    expect(validateThreadSettings('codex', { model: 'opus' })).toMatch(/Codex/);
    expect(validateThreadSettings('codex', { model: 'claude-opus-5-5' })).toMatch(/Codex/);
  });
  it('refuses an empty change, a Codex reset, a bad effort and junk', () => {
    expect(validateThreadSettings('claude-code', {})).toMatch(/model or an effort/);
    expect(validateThreadSettings('codex', { model: null })).toMatch(/pick a model/i);
    expect(validateThreadSettings('claude-code', { effort: 'bogus' })).toMatch(/effort/);
    expect(validateThreadSettings('codex', { effort: 'max' })).toMatch(/effort/);
    expect(validateThreadSettings('claude-code', { model: 'a b' })).toMatch(/model/);
    expect(validateThreadSettings('claude-code', { model: 42 as any })).toMatch(/model/);
  });
  it('refuses Grok and OpenCode for now', () => {
    expect(validateThreadSettings('grok', { model: 'grok-4.5' })).toMatch(/not yet/i);
    expect(validateThreadSettings('opencode', { effort: 'high' })).toMatch(/not yet/i);
  });
});

it('exposes the effort levels the picker offers', () => {
  expect(EFFORT_LEVELS['claude-code']).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
  expect(EFFORT_LEVELS.codex).toEqual(['low', 'medium', 'high', 'xhigh']);
});
