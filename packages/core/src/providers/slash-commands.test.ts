import { describe, it, expect } from 'vitest';
import {
  parseSlash, slashCommandsFor, validateEffort, resolveModelArg, resolveEffortArg, catalogModelChoices, EFFORT_LEVELS,
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
  it('Grok and OpenCode: /model works (the chip switches them), /effort and /compact are greyed with a reason, no /cli', () => {
    for (const h of ['grok', 'opencode'] as const) {
      const cmds = slashCommandsFor('thread', h);
      expect(cmds.find((c) => c.name === 'model')!.disabledReason).toBeUndefined();
      expect(cmds.find((c) => c.name === 'effort')!.disabledReason).toMatch(/not yet/i);
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
  it('matches a model by label or id, case-insensitive, among the options it is given', () => {
    const claude = catalogModelChoices('claude-code');
    expect(resolveModelArg(claude, 'Opus')).toEqual({ model: 'opus' });
    const codex = catalogModelChoices('codex');
    expect(resolveModelArg(codex, '6 astra')).toEqual({ model: 'gpt-6-astra' });
    expect(resolveModelArg(codex, 'gpt-5.6-sol')).toEqual({ model: 'gpt-5.6-sol' });
    expect(resolveModelArg([{ value: 'x/y', label: 'My model' }], 'my model')).toEqual({ model: 'x/y' });
  });
  it('has no Default: a live switch needs a concrete model', () => {
    expect(catalogModelChoices('claude-code').map((m) => m.value)).toEqual(['fable', 'opus', 'sonnet', 'haiku']);
    expect((resolveModelArg(catalogModelChoices('claude-code'), 'default') as any).error).toMatch(/Unknown model/);
  });
  it('lists the choices for an unknown model', () => {
    const r = resolveModelArg(catalogModelChoices('claude-code'), 'banana');
    expect((r as any).error).toMatch(/opus/);
  });
  it('matches an effort level, or one of the levels it is given', () => {
    expect(resolveEffortArg('claude-code', 'HIGH')).toEqual({ effort: 'high' });
    expect(resolveEffortArg('codex', 'xhigh')).toEqual({ effort: 'xhigh' });
    expect((resolveEffortArg('claude-code', 'bogus') as any).error).toMatch(/low, medium, high, xhigh, max/);
    expect((resolveEffortArg('grok', 'high') as any).error).toBeTruthy();
    expect((resolveEffortArg('codex', 'ultra', ['low', 'max']) as any).error).toMatch(/low, max/);
    expect(resolveEffortArg('codex', 'max', ['low', 'max'])).toEqual({ effort: 'max' });
  });
});

describe('validateEffort', () => {
  it('accepts a known level for Claude and Codex', () => {
    expect(validateEffort('claude-code', 'max')).toBeNull();
    expect(validateEffort('codex', 'ultra')).toBeNull();
  });
  it('refuses a bad level, a non-string, and Grok or OpenCode for now', () => {
    expect(validateEffort('claude-code', 'bogus')).toMatch(/Unknown effort/);
    expect(validateEffort('codex', 'turbo')).toMatch(/Unknown effort/);
    expect(validateEffort('claude-code', 42)).toMatch(/level name/);
    expect(validateEffort('grok', 'high')).toMatch(/not yet/i);
    expect(validateEffort('opencode', 'high')).toMatch(/not yet/i);
  });
  it('checks Codex against the efforts of the thread\'s model when given', () => {
    const luna = ['low', 'medium', 'high', 'xhigh', 'max'];
    expect(validateEffort('codex', 'ultra', { codexEfforts: luna, codexModel: 'gpt-6-luna' })).toMatch(/gpt-6-luna does not take that effort.*low, medium, high, xhigh, max/);
    expect(validateEffort('codex', 'max', { codexEfforts: luna })).toBeNull();
  });
});

it('exposes the effort levels the picker offers', () => {
  expect(EFFORT_LEVELS['claude-code']).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
  expect(EFFORT_LEVELS.codex).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
});
