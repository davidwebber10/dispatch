// W3-A: `EventBroadcaster.broadcast` is typed with the union of ws/server-events.ts. The `@ts-expect-error`
// lines are the test: `pnpm run typecheck` fails when one of them stops being an error.
import { describe, expect, test } from 'vitest';
import { WebSocketServer } from 'ws';
import { createEventsBroadcaster, createNoopBroadcaster, type EventBroadcaster } from '../ws/events.js';
import type { DeclaredServerEvent } from '../ws/server-events.js';

describe('the typed broadcaster', () => {
  test('a declared event type must have its declared shape; any other type passes', () => {
    const b: EventBroadcaster = createNoopBroadcaster();
    b.broadcast({ type: 'terminal:status', terminalId: 't1', status: 'working' });
    b.broadcast({ type: 'terminal:status', terminalId: 't1', status: 'working', activity: null });
    // @ts-expect-error terminalId is required
    b.broadcast({ type: 'terminal:status', status: 'working' });
    // @ts-expect-error sessionId is a string
    b.broadcast({ type: 'session:tabs-changed', sessionId: 5 });
    // @ts-expect-error a field that the event does not have
    b.broadcast({ type: 'ledger:changed', sessionId: 's1', extra: true });
    // @ts-expect-error an event has a type
    b.broadcast({ sessionId: 's1' });
    // The events that only plugins read are declared too.
    b.broadcast({ type: 'plugin:settings', id: 'coach' });
    // @ts-expect-error id is required
    b.broadcast({ type: 'plugin:settings' });
    b.broadcast({ type: 'thread:spawned', terminalId: 't1', sessionId: 's1', harness: 'claude-code', at: '2026-11-09T00:00:00Z' });
    // A plugin's own event, and a type that is only known at run time.
    b.broadcast({ type: 'coach:review-ready', reviewId: 'r1' });
    const dynamic: string = ['auth', 'request'].join(':');
    b.broadcast({ type: dynamic, request: {} });
    // A value of the union passes as it is.
    const e: DeclaredServerEvent = { type: 'analytics-dirty' };
    b.broadcast(e);
    expect(true).toBe(true);
  });

  test('the events broadcaster sends the event as JSON to every open client', () => {
    const wss = new WebSocketServer({ noServer: true });
    const sent: string[] = [];
    const client = { readyState: 1, bufferedAmount: 0, send: (m: string) => { sent.push(m); } };
    const closed = { readyState: 3, bufferedAmount: 0, send: () => { throw new Error('closed'); } };
    wss.clients.add(client as never);
    wss.clients.add(closed as never);
    createEventsBroadcaster(wss).broadcast({ type: 'session:archived', sessionId: 's1' });
    expect(sent.map((m) => JSON.parse(m))).toEqual([{ type: 'session:archived', sessionId: 's1' }]);
  });
});
