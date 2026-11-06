import { describe, it, expect } from 'vitest';
import type { Terminal } from '../api/types';
import { isAgentStarted, startedByOf, startedByText } from './startedBy';

const term = (id: string, label: string, config: Record<string, unknown> = {}, type = 'claude-code') =>
  ({ id, sessionId: 'A', type, label, status: 'idle', config, createdAt: 'x', lastActivityAt: null, archivedAt: null }) as unknown as Terminal;

const overseer = term('ov', 'Overseer tab', { role: 'coordinator' });
const chatThread = term('ch', 'Review PR 5', { role: 'agent', origin: 'endless' });
const plain = term('pl', 'Fix login');
const store = new Map([overseer, chatThread, plain].map((t) => [t.id, t]));
const find = (id: string) => store.get(id) ?? null;

describe('isAgentStarted: the Mine / Agents split', () => {
  it('plain thread, overseer tab, shell and branch are Mine', () => {
    expect(isAgentStarted({})).toBe(false);
    expect(isAgentStarted({ role: 'coordinator' })).toBe(false);
    expect(isAgentStarted({ branchFrom: 'abc' })).toBe(false);
  });
  it('role agent, origin endless and a roleRun are Agents', () => {
    expect(isAgentStarted({ role: 'agent' })).toBe(true);
    expect(isAgentStarted({ origin: 'endless' })).toBe(true);
    expect(isAgentStarted({ roleRun: 'run-1' })).toBe(true);
  });
  it('an empty roleRun does not count', () => {
    expect(isAgentStarted({ roleRun: '' })).toBe(false);
  });
  it('bad or missing config is Mine and does not throw', () => {
    for (const bad of [null, undefined, 'x', 5, [], { role: 7 }]) expect(isAgentStarted(bad as never)).toBe(false);
  });
});

describe('startedByOf: mirrors core endless/pane.ts startedByOf', () => {
  it('user for a plain thread, an overseer tab, a shell and a branch', () => {
    expect(startedByOf(plain, find)).toEqual({ startedBy: 'user', via: null });
    expect(startedByOf(overseer, find)).toEqual({ startedBy: 'user', via: null });
    expect(startedByOf(term('s', 'sh', {}, 'shell'), find)).toEqual({ startedBy: 'user', via: null });
    expect(startedByOf(term('b', 'br', { branchFrom: 'pl' }), find)).toEqual({ startedBy: 'user', via: null });
  });
  it('origin endless is Chat', () => {
    expect(startedByOf(chatThread, find)).toEqual({ startedBy: 'chat', via: null });
  });
  it('a roleRun is Role', () => {
    expect(startedByOf(term('r', 'r', { role: 'agent', roleRun: 'x' }), find)).toEqual({ startedBy: 'role', via: null });
  });
  it('role agent with no spawnedBy is Overseer (rows from before spawnedBy)', () => {
    expect(startedByOf(term('o', 'o', { role: 'agent' }), find)).toEqual({ startedBy: 'overseer', via: null });
  });
  it('spawnedBy an overseer tab is Overseer', () => {
    expect(startedByOf(term('o', 'o', { role: 'agent', spawnedBy: 'ov' }), find)).toEqual({ startedBy: 'overseer', via: null });
  });
  it('spawnedBy a Chat thread is Chat, via its name', () => {
    expect(startedByOf(term('o', 'o', { role: 'agent', spawnedBy: 'ch' }), find)).toEqual({ startedBy: 'chat', via: 'Review PR 5' });
  });
  it('spawnedBy a plain thread is a thread, via its name', () => {
    expect(startedByOf(term('o', 'o', { role: 'agent', spawnedBy: 'pl' }), find)).toEqual({ startedBy: 'thread', via: 'Fix login' });
  });
  it('spawnedBy a thread not in the store is a thread with no name', () => {
    expect(startedByOf(term('o', 'o', { role: 'agent', spawnedBy: 'gone' }), find)).toEqual({ startedBy: 'thread', via: null });
  });
  it('bad config is user and does not throw', () => {
    expect(startedByOf({ ...plain, config: null } as unknown as Terminal, find)).toEqual({ startedBy: 'user', via: null });
  });
});

describe('startedByText: the words the Chat pane shows', () => {
  it('has no word for the owner and uses the Chat pane words otherwise', () => {
    expect(startedByText({ startedBy: 'user', via: null })).toBe('');
    expect(startedByText({ startedBy: 'chat', via: null })).toBe('Chat');
    expect(startedByText({ startedBy: 'chat', via: 'Review PR 5' })).toBe('Chat, via Review PR 5');
    expect(startedByText({ startedBy: 'overseer', via: null })).toBe('Overseer');
    expect(startedByText({ startedBy: 'role', via: null })).toBe('Role');
    expect(startedByText({ startedBy: 'thread', via: 'Fix login' })).toBe('via Fix login');
    expect(startedByText({ startedBy: 'thread', via: null })).toBe('via a thread');
  });
});
