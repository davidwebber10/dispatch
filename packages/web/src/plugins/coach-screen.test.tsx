import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react';
import { createCoach } from '../../../plugins/coach/web.js';
import { emptyCadence, mute } from '../../../plugins/coach/lib/cadence.mjs';
import { fakeD, type FakeD } from './coach-test-utils';

const NOW = new Date(2026, 10, 23, 11, 0);
const SEASONED = emptyCadence(new Date(2026, 10, 1, 9, 0));
const CARD = {
  id: 'no-plan-big-task:t1:x', type: 'no-plan-big-task', measure: 'judgment', terminalId: 't1', projectId: 's1',
  headline: 'Ask for a plan first', why: 'This task has 4 parts. A plan lets you fix the approach before it runs.',
  action: { kind: 'compose', label: 'Ask for a plan', text: 'Before you start, write a short plan and wait for my OK.' },
  excerpt: 'pull last week returns', reason: 'Your prompt had 4 parts and did not ask for a plan first.', at: '2026-11-23T10:00:00Z',
};
const OLD = { ...CARD, id: 'idle-wait:t9:y', type: 'idle-wait', measure: 'delegation', terminalId: 't9', headline: 'Start a second thread while this runs', at: '2026-11-20T10:00:00Z' };
const MEASURES = {
  at: '2026-11-23T10:00:00Z', weakest: 'reuse', history: [],
  scores: {
    ambition: { score: 62, trend: 1, enough: true }, delegation: { score: 45, trend: 0, enough: true }, reuse: { score: 20, trend: 0, enough: true },
    judgment: { score: 70, trend: -1, enough: true }, breadth: { score: 30, trend: 0, enough: false },
  },
};
type Comp = (p: Record<string, unknown>) => JSX.Element | null;

async function boot(over: { docs?: Record<string, unknown>; model?: Record<string, unknown>; actions?: Record<string, unknown> } = {}) {
  const d: FakeD = fakeD({ docs: { cadence: SEASONED, cards: { items: [OLD, CARD] }, measures: MEASURES, ...(over.docs ?? {}) }, model: over.model, actions: over.actions });
  const coach = createCoach(d.sdk, { now: () => NOW });
  await coach.ready;
  const reg = d.registered.coach as Record<string, { Component: Comp }[]>;
  return { d, Tab: reg.inspectorTabs[0].Component, View: reg.views[0].Component };
}

afterEach(() => { cleanup(); });

describe('Coach right-column tab (coach plan Task 12)', () => {
  it('shows the open thread\'s card; the five measures are on the Coach screen: the weakest is the focus, trends have names', async () => {
    const { Tab, View } = await boot({ model: {} });
    const v = render(<Tab terminalId="t1" sessionId="s1" />);
    const card = await screen.findByTestId('coach-card');
    expect(card).toHaveTextContent('Ask for a plan first');
    expect(card).not.toHaveTextContent('Start a second thread');
    expect(screen.queryByTestId('coach-measures')).toBeNull();
    v.unmount();
    render(<View />);
    const m = await screen.findByTestId('coach-measures');
    expect(m).toHaveTextContent('YOUR FIVE MEASURES · 30 DAYS');
    for (const label of ['Ambition', 'Delegation', 'Reuse', 'Judgment', 'Breadth']) expect(m).toHaveTextContent(label);
    expect(within(m).getByTestId('measure-reuse')).toHaveTextContent('focus');
    expect(within(m).getByLabelText('Ambition: up')).toBeInTheDocument();
    expect(within(m).getByLabelText('Judgment: down')).toBeInTheDocument();
    expect(within(m).getByTestId('measure-breadth')).toHaveTextContent('Not enough data yet');
    expect(m).toHaveTextContent('Bars compare you with your own past, never with other people.');
  });

  it('the tab works during a mute; it never counts toward the daily cap', async () => {
    const { Tab, d } = await boot({ docs: { cadence: mute(SEASONED, 'hour', NOW) } });
    render(<Tab terminalId="t1" sessionId="s1" />);
    expect(await screen.findByTestId('coach-card')).toBeInTheDocument();
    expect((d.docs.get('cadence') as { shownToday: number }).shownToday).toBe(0);
  });

  it('with no thread open it says so; a thread with no card says so', async () => {
    const { Tab } = await boot();
    const v = render(<Tab terminalId={null} sessionId={null} />);
    expect(await screen.findByText('Open a thread to see what the Coach sees in it.')).toBeInTheDocument();
    v.unmount();
    render(<Tab terminalId="t5" sessionId="s1" />);
    expect(await screen.findByText('The Coach has nothing for this thread yet.')).toBeInTheDocument();
  });

  it('Try it in the tab copies the prompt (the tab has no message box) and sends nothing', async () => {
    const { Tab, d } = await boot();
    render(<Tab terminalId="t1" sessionId="s1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Ask for a plan' }));
    await waitFor(() => expect(d.copyText).toHaveBeenCalledWith('Before you start, write a short plan and wait for my OK.'));
    expect(d.hint).toHaveBeenCalledWith('Copied. Paste it into the message box.');
    expect(d.assist).not.toHaveBeenCalled();
  });
});

describe('Coach screen (coach plan Task 12)', () => {
  const model = {
    usage: vi.fn(async () => ({ calls: 212, failed: 1, inputTokens: 318_000, outputTokens: 41_000, costUsd: 1.2, byModel: [{ model: 'claude-haiku-5-5', harness: 'claude', calls: 205, inputTokens: 300_000, outputTokens: 30_000 }, { model: 'opus', harness: 'claude', calls: 7, inputTokens: 18_000, outputTokens: 11_000 }] })),
    share: vi.fn(async () => ({ fiveHour: { usedPercent: 40, pluginPercent: 0.8, pluginTokens: 1, accountTokens: 2, resetsAt: null }, sevenDay: { usedPercent: 30, pluginPercent: 1.6, pluginTokens: 1, accountTokens: 2, resetsAt: null } })),
    budget: vi.fn(async () => ({ percentWeekly: 3, usdWeekly: 5 })),
  };

  it('shows the cost block: calls by model, tokens, the share labeled an estimate, and the budget meter', async () => {
    const { View } = await boot({ model, docs: { status: { budget: { usedPercent: 1.6, capPercent: 3 }, level: 'balanced', stepped: false, harness: 'claude' } } });
    render(<View />);
    const cost = await screen.findByTestId('coach-cost');
    await waitFor(() => expect(cost).toHaveTextContent('212'));
    expect(cost).toHaveTextContent('claude-haiku-5-5 205');
    expect(cost).toHaveTextContent('opus 7');
    expect(cost).toHaveTextContent('318k in · 41k out');
    expect(cost).toHaveTextContent('≈ 1.6% (estimate)');
    expect(cost).toHaveTextContent('5-hour: ≈ 0.8%');
    const meter = within(cost).getByRole('meter', { name: 'Budget used' });
    expect(meter).toHaveAttribute('aria-valuenow', '1.6');
    expect(meter).toHaveAttribute('aria-valuemax', '3');
    expect(cost).toHaveTextContent('3% of your weekly limit');
  });

  it('says when the Coach stepped down near the budget', async () => {
    const { View } = await boot({ model, docs: { status: { budget: { usedPercent: 2.5, capPercent: 3 }, level: 'economy', stepped: true } } });
    render(<View />);
    expect(await screen.findByText('Near the budget, the Coach stepped down to Economy.')).toBeInTheDocument();
  });

  it('lists the card history, newest first, with what happened to each', async () => {
    const { View } = await boot({ model, docs: { cardState: { [OLD.id]: { state: 'dismissed', at: '2026-11-20T11:00:00Z' } } } });
    render(<View />);
    const hist = await screen.findByTestId('coach-history');
    const rows = within(hist).getAllByRole('listitem');
    expect(rows[0]).toHaveTextContent('Ask for a plan first');
    expect(rows[0]).toHaveTextContent('New');
    expect(rows[1]).toHaveTextContent('Start a second thread while this runs');
    expect(rows[1]).toHaveTextContent('Dismissed');
  });

  it('shows the weekly recap with its stretch; Set it up opens the dialog and starts nothing; seeing it clears the badge', async () => {
    const openSchedule = vi.fn();
    const recap = { at: '2026-11-23T08:00:00Z', announce: true, week: '2026-11-23', stats: { threads: 38, days: 6, parallel: 4 }, patterns: ['You typed the same prompt 5 times.', 'Your longest hands-off run was 22 minutes.', 'You ran up to 4 threads at a time.'], stretch: { measure: 'reuse', headline: 'Turn your repeated prompt into a schedule', why: 'You sent the same prompt 5 times this week.', action: { kind: 'schedule', label: 'Set it up', prompt: 'summarize yesterday', cron: '0 8 * * 1-5' }, check: 'Stop it any time.' }, learned: 'The Coach learned: "Not a developer."' };
    const { View, d } = await boot({ model, docs: { recap }, actions: { openSchedule } });
    expect(d.actions.setBadge).toHaveBeenCalledWith('plugin:coach:coach', 1);
    render(<View />);
    const r = await screen.findByTestId('coach-recap');
    expect(r).toHaveTextContent('Your week with AI');
    expect(r).toHaveTextContent('38 threads · 6 days · up to 4 at a time');
    for (const p of recap.patterns) expect(r).toHaveTextContent(p);
    expect(r).toHaveTextContent('The Coach learned: "Not a developer."');
    fireEvent.click(within(r).getByRole('button', { name: 'Set it up' }));
    expect(openSchedule).toHaveBeenCalledWith({ prompt: 'summarize yesterday', cron: '0 8 * * 1-5', label: 'Set it up' });
    await waitFor(() => expect(d.actions.setBadge).toHaveBeenLastCalledWith('plugin:coach:coach', 0));
    expect((d.docs.get('cadence') as { recapSeen?: string }).recapSeen).toBe(recap.at);
  });

  it('a recap written during a mute does not set the badge', async () => {
    const { d } = await boot({ model, docs: { recap: { at: '2026-11-23T08:00:00Z', announce: false, stats: { threads: 1, days: 5, parallel: 1 }, patterns: ['x'], stretch: null, learned: null } } });
    expect(d.actions.setBadge).not.toHaveBeenCalledWith('plugin:coach:coach', 1);
  });
});

describe('Coach web part: no emoji, no literal colors (themes)', () => {
  it('web.js has no emoji and no literal color', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../../plugins/coach/web.js'), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\\w])\/\/.*$/gm, '$1');
    expect(code).not.toMatch(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/u);
    expect(code).not.toMatch(/(?<![\w&/])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})\b/);
    expect(code).not.toMatch(/\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(/);
  });
  it('every CSS variable web.js uses is a token the theme defines', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../../plugins/coach/web.js'), 'utf8');
    const theme = fs.readFileSync(path.resolve(__dirname, '../theme.css'), 'utf8');
    const used = [...new Set([...src.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]))];
    expect(used.length).toBeGreaterThan(5);
    expect(used.filter((v) => !theme.includes(`${v}:`))).toEqual([]);
  });
});
