import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parseServerEvent, resetServerEventWarnings, type EventOf, type ServerEvent } from './server-events';

describe('parseServerEvent', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { resetServerEventWarnings(); warn = vi.spyOn(console, 'warn').mockImplementation(() => {}); });
  afterEach(() => { warn.mockRestore(); });

  it('a terminal:status frame with no terminalId is dropped', () => {
    expect(parseServerEvent(JSON.stringify({ type: 'terminal:status', status: 'working' }))).toBeNull();
    expect(parseServerEvent(JSON.stringify({ type: 'terminal:status', terminalId: 7, status: 'working' }))).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1); // one warning per type, not one per frame
    expect(String(warn.mock.calls[0][0])).toContain('terminal:status');
  });

  it('a good terminal:status frame passes with its fields', () => {
    const e = parseServerEvent(JSON.stringify({ type: 'terminal:status', terminalId: 't1', status: 'working', threadStatus: 'working', activity: null }));
    expect(e).toEqual({ type: 'terminal:status', terminalId: 't1', status: 'working', threadStatus: 'working', activity: null });
    expect(warn).not.toHaveBeenCalled();
  });

  it('an unknown type passes as UnknownServerEvent', () => {
    const e = parseServerEvent(JSON.stringify({ type: 'plugin:job', id: 'coach', at: 'now', extra: [1, 2] }));
    expect(e).toEqual({ type: 'plugin:job', id: 'coach', at: 'now', extra: [1, 2] });
    expect(warn).not.toHaveBeenCalled();
  });

  it('a non-object frame is dropped', () => {
    for (const raw of ['"text"', '42', 'null', '[1,2]', 'not json', '', '{"type":5}', '{"noType":true}']) {
      expect(parseServerEvent(raw)).toBeNull();
    }
  });

  it('a required object or array field of the wrong kind drops the frame', () => {
    expect(parseServerEvent(JSON.stringify({ type: 'session:created', session: 'x' }))).toBeNull();
    expect(parseServerEvent(JSON.stringify({ type: 'session:created', session: null }))).toBeNull();
    expect(parseServerEvent(JSON.stringify({ type: 'session:created', session: { id: 's1' } }))).not.toBeNull();
    expect(parseServerEvent(JSON.stringify({ type: 'plugin:updates', updates: {} }))).toBeNull();
    expect(parseServerEvent(JSON.stringify({ type: 'plugin:updates', updates: [] }))).not.toBeNull();
    expect(parseServerEvent(JSON.stringify({ type: 'usage-limits', warnPercent: '80', providers: [], paused: [] }))).toBeNull();
  });

  it('a known type with no required field passes bare', () => {
    expect(parseServerEvent('{"type":"analytics-dirty"}')).toEqual({ type: 'analytics-dirty' });
    expect(parseServerEvent('{"type":"update:in-progress"}')).toEqual({ type: 'update:in-progress' });
  });

  it('optional fields are not checked, so an older daemon frame still passes', () => {
    expect(parseServerEvent(JSON.stringify({ type: 'session:status', sessionId: 's1', status: 'working' }))).not.toBeNull();
    expect(parseServerEvent(JSON.stringify({ type: 'session:status', sessionId: 's1', status: 'working', lastActivityAt: null }))).not.toBeNull();
  });

  it('EventOf picks the member by its type (compile-time check)', () => {
    const e: EventOf<'terminal:status'> = { type: 'terminal:status', terminalId: 't1', status: 'waiting' };
    const asUnion: ServerEvent = e;
    expect(asUnion.type).toBe('terminal:status');
  });
});
