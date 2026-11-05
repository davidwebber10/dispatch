import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PtyLimitWatcher } from './pty-watch.js';

const banner = "  ⎿  You've hit your session limit · resets 1:10am (America/Indianapolis)\r\n";
let hits: { id: string; kind: string }[];
let idle: boolean;
let w: PtyLimitWatcher;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.UTC(2026, 9, 24, 4, 31));
  hits = []; idle = true;
  w = new PtyLimitWatcher({ isIdle: () => idle, onLimit: (id, l) => hits.push({ id, kind: l.kind }), confirmMs: 5000 });
});
afterEach(() => { w.forget('t1'); vi.useRealTimers(); });
const quiet = (ms = 5000) => vi.advanceTimersByTime(ms);

describe('PtyLimitWatcher', () => {
  it('parks only after the terminal stays quiet for the confirm delay', () => {
    w.feed('t1', banner);
    expect(hits).toEqual([]);
    vi.advanceTimersByTime(5000);
    expect(hits).toEqual([{ id: 't1', kind: 'session' }]);
  });
  it('a banner split across two chunks is still found', () => {
    w.feed('t1', "You've hit your session limit · res");
    w.feed('t1', 'ets 1:10am (America/Indianapolis)\r\n');
    vi.advanceTimersByTime(5000);
    expect(hits).toHaveLength(1);
  });
  it('an agent that quotes the text and keeps working never parks', () => {
    w.feed('t1', banner);
    idle = false; // the terminal went on working
    vi.advanceTimersByTime(5000);
    expect(hits).toEqual([]);
  });
  it('reports a banner once, not on every redraw', () => {
    w.feed('t1', banner); w.feed('t1', banner); w.feed('t1', banner);
    vi.advanceTimersByTime(5000);
    w.feed('t1', banner);
    vi.advanceTimersByTime(5000);
    expect(hits).toHaveLength(1);
  });
  it('ordinary output is ignored', () => {
    w.feed('t1', 'npm test\r\nall green\r\n');
    vi.advanceTimersByTime(10000);
    expect(hits).toEqual([]);
  });
  it('new output after the banner (the agent went on talking) restarts the quiet wait', () => {
    w.feed('t1', banner);
    quiet(3000);
    w.feed('t1', 'Here is how the limit banner works...\r\n');
    quiet(3000);
    expect(hits).toEqual([]);
    quiet(2000);
    expect(hits).toHaveLength(1);
  });
  it('a repaint that is only the banner does not restart the wait', () => {
    w.feed('t1', banner);
    quiet(3000);
    w.feed('t1', banner);
    quiet(2000);
    expect(hits).toHaveLength(1);
  });
  it('forget cancels a pending detection (the owner took over)', () => {
    w.feed('t1', banner);
    w.forget('t1');
    quiet(10000);
    expect(hits).toEqual([]);
  });
  it('reads the reset from the whole banner when the chunks split it', () => {
    const seen: (number | null)[] = [];
    const w2 = new PtyLimitWatcher({ isIdle: () => true, onLimit: (_i, l) => seen.push(l.resetsAt), confirmMs: 5000 });
    w2.feed('t2', "You've hit your session limit · resets");
    w2.feed('t2', ' 1:10am (America/Indianapolis)\r\n');
    vi.advanceTimersByTime(5000);
    expect(seen).toEqual([Date.UTC(2026, 9, 24, 5, 10)]);
    w2.forget('t2');
  });
  it('a redraw of the same banner after the reset passed is not a new limit', () => {
    w.feed('t1', banner); quiet(5000);
    vi.setSystemTime(Date.UTC(2026, 9, 24, 5, 11));
    w.feed('t1', banner); quiet(5000);
    expect(hits).toHaveLength(1);
  });
  it('a quoted banner followed by a page of prose never parks, even when the terminal goes quiet', () => {
    w.feed('t1', banner);
    w.feed('t1', 'So that is what the banner looks like. When the CLI hits its limit it prints that line and waits. ' + 'The daemon notices the reset time and schedules the wake. '.repeat(4) + '\r\n');
    quiet(10000);
    expect(hits).toEqual([]);
  });
  it('a repaint that keeps the terminal busy at confirm time delays the park, it does not drop it', () => {
    let busyFor = 1;
    const w3 = new PtyLimitWatcher({ isIdle: () => busyFor-- <= 0, onLimit: (id, l) => hits.push({ id, kind: l.kind }), confirmMs: 5000 });
    w3.feed('t3', banner);
    quiet(5000);
    expect(hits).toEqual([]);
    quiet(5000);
    expect(hits).toEqual([{ id: 't3', kind: 'session' }]);
    w3.forget('t3');
  });
  it('a quote followed by prose on the same line never parks', () => {
    w.feed('t1', "As an example the CLI prints: You've hit your session limit · resets 1:10am (America/Indianapolis) and then it waits for the reset, which is why the daemon has to wake the thread by itself later on.\r\n");
    quiet(10000);
    expect(hits).toEqual([]);
  });
  it('a Fable banner parks once the terminal is quiet', () => {
    w.feed('t1', "  ⎿  You've hit your Fable limit · resets Fri 1:41 PM\r\n");
    quiet(5000);
    expect(hits).toEqual([{ id: 't1', kind: 'fable' }]);
  });
  it('a timeless "reached your Fable limit" screen parks only when quiet', () => {
    w.feed('t1', "You've reached your Fable limit. Switch to another model to continue.\r\n");
    quiet(5000);
    expect(hits).toEqual([{ id: 't1', kind: 'fable' }]);
  });
  it('quoted Fable text in prose never parks', () => {
    w.feed('t1', "The CLI shows You've hit your Fable limit · resets Fri 1:41 PM when the quota ends, and Dispatch then pauses the thread until the reset so nothing is lost overnight.\r\n");
    w.feed('t1', "You've reached your Fable limit is the other wording, used when credits are needed.\r\n");
    quiet(10000);
    expect(hits).toEqual([]);
  });
});


describe('PtyLimitWatcher with the Codex banner', () => {
  const codexBanner = "■ You've hit your usage limit. Upgrade to Plus to continue using Codex (https://chatgpt.com/explore/plus), or try again at 9:15 AM.\r\n";
  let got: { id: string; provider?: string; kind: string }[];
  let cw: PtyLimitWatcher;
  beforeEach(() => {
    got = [];
    cw = new PtyLimitWatcher({ isIdle: () => idle, onLimit: (id, l, provider) => got.push({ id, provider, kind: l.kind }), confirmMs: 5000 });
  });
  afterEach(() => { cw.forget('c1'); });

  it('names the provider whose banner it was, once the terminal is quiet', () => {
    cw.feed('c1', codexBanner);
    quiet();
    expect(got).toEqual([{ id: 'c1', provider: 'codex', kind: 'usage' }]);
  });
  it('a Claude banner is reported as claude-code', () => {
    cw.feed('c1', banner);
    quiet();
    expect(got).toEqual([{ id: 'c1', provider: 'claude-code', kind: 'session' }]);
  });
  it('the Codex prompt box left after the banner does not count as more talk', () => {
    cw.feed('c1', codexBanner + '\r\n  gpt-6-astra high · ~/Developer/Projects/app            100% context left\r\n› Ask Codex to do anything\r\n');
    quiet();
    expect(got).toHaveLength(1);
  });
  it('a quoted Codex banner followed by prose never parks', () => {
    cw.feed('c1', codexBanner);
    cw.feed('c1', 'That is the message the CLI prints. After it the agent stops and waits for you to send a message. ' + 'The daemon reads the time and wakes the thread by itself when it is over. '.repeat(8) + '\r\n');
    quiet(10000);
    expect(got).toEqual([]);
  });
  it('a Codex banner in the middle of a sentence never parks', () => {
    cw.feed('c1', "In the docs, Codex prints: You've hit your usage limit. Upgrade to Plus to continue using Codex, or try again at 9:15 AM. And that is all.\r\n");
    quiet(10000);
    expect(got).toEqual([]);
  });
  it('reports a repainted Codex banner once', () => {
    cw.feed('c1', codexBanner); cw.feed('c1', codexBanner);
    quiet();
    cw.feed('c1', codexBanner);
    quiet();
    expect(got).toHaveLength(1);
  });

  it('a wrapped Codex banner is not claimed by the Claude detector', () => {
    const wrapped = "You've hit your usage limit.\r\nUpgrade to Plus to continue using Codex (https://chatgpt.com/explore/plus), or try again at 9:15 AM.\r\n";
    // Claude's detector reads "You've hit your usage limit." at a line end as its own banner, so a terminal is read only for its own CLI.
    const typed = new PtyLimitWatcher({ isIdle: () => true, onLimit: (id, l, provider) => got.push({ id, provider, kind: l.kind }), confirmMs: 5000, providerOf: () => 'codex' });
    typed.feed('c1', wrapped); quiet();
    expect(got).toEqual([{ id: 'c1', provider: 'codex', kind: 'usage' }]);
    typed.forget('c1');
  });
  it('a terminal of one CLI is only read for that CLI\'s banner', () => {
    const typed: Record<string, string | undefined> = { cl: 'claude-code', cx: 'codex', sh: 'shell' };
    const tw = new PtyLimitWatcher({ isIdle: () => true, onLimit: (id, l, provider) => got.push({ id, provider, kind: l.kind }), confirmMs: 5000, providerOf: (id) => typed[id] });
    tw.feed('cl', codexBanner);   // Codex text in a Claude thread
    tw.feed('cx', banner);        // Claude text in a Codex thread
    tw.feed('sh', codexBanner);   // a plain shell
    tw.feed('sh', banner);
    quiet(10000);
    expect(got).toEqual([]);
    tw.feed('cx', codexBanner);
    tw.feed('cl', banner);
    quiet();
    expect(got.map((g) => `${g.id}:${g.provider}`).sort()).toEqual(['cl:claude-code', 'cx:codex']);
    for (const id of Object.keys(typed)) tw.forget(id);
  });
});
