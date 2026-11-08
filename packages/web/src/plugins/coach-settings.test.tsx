import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react';
import { createCoach } from '../../../plugins/coach/web.js';
import { DEFAULT_THRESHOLDS } from '../../../plugins/coach/lib/settings.mjs';
import { emptyCadence } from '../../../plugins/coach/lib/cadence.mjs';
import { fakeD, type FakeD } from './coach-test-utils';
import { pickOption } from '../test/select';

const NOW = new Date(2026, 10, 23, 11, 0);
type Comp = (p: Record<string, unknown>) => JSX.Element | null;
type Saved = Record<string, unknown> & { advanced?: { thresholds?: Record<string, Record<string, number>>; minConfidence?: number } };

async function boot(over: { settings?: unknown; api?: Record<string, unknown> } = {}) {
  const d: FakeD = fakeD({ docs: { cadence: emptyCadence(new Date(2026, 10, 1)) }, settings: over.settings, api: over.api });
  const coach = createCoach(d, { now: () => NOW });
  await coach.ready;
  const Settings = (d.registered.coach as Record<string, { Component: Comp }[]>).settings[0].Component;
  render(<Settings />);
  await screen.findByTestId('coach-settings');
  return { d, saved: () => (d.settingsValue.current ?? {}) as Saved };
}
afterEach(() => { cleanup(); });

describe('Coach settings (coach plan Task 13; laid out again 2026-11-07)', () => {
  it('the page is a few grouped cards in order, with the long lists and the advanced items closed', async () => {
    await boot();
    const page = screen.getByTestId('coach-settings');
    const titles = within(page).getAllByRole('group').map((g) => g.getAttribute('aria-label')).filter(Boolean);
    expect(titles).toEqual(['Coach', 'What it suggests', 'What it looks at', 'Recap and measures', 'Cost and models', 'Data', 'Advanced']);
    // No wall of checkboxes: the projects are behind one row.
    expect(within(page).queryByRole('checkbox')).toBeNull();
    // The advanced items wait behind the disclosure.
    expect(within(page).queryByRole('spinbutton', { name: 'Most cards in a day' })).toBeNull();
    expect(within(page).queryByRole('radiogroup', { name: 'Model' })).toBeNull();
    expect(within(page).queryByRole('spinbutton', { name: 'OpenRouter budget, dollars a week' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Advanced' })).toHaveAttribute('aria-expanded', 'false');
  });

  it('How often writes its setting, and says what the picked level does', async () => {
    const { saved } = await boot();
    const group = screen.getByRole('radiogroup', { name: 'How often' });
    expect(within(group).getByRole('radio', { name: 'Normal' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText('Up to 3 cards a day.')).toBeInTheDocument();
    fireEvent.click(within(group).getByRole('radio', { name: 'Chatty' }));
    await waitFor(() => expect(saved().howOften).toBe('chatty'));
    expect(screen.getByText('Up to 8 cards a day.')).toBeInTheDocument();
    fireEvent.click(within(group).getByRole('radio', { name: 'Quiet' }));
    await waitFor(() => expect(saved().howOften).toBe('quiet'));
    expect(screen.getByText(/Only the weekly recap and the right-column tab/)).toBeInTheDocument();
  });

  it('the caps, quiet hours, phone, tip types and the recap each write their setting', async () => {
    const { saved } = await boot();
    fireEvent.click(screen.getByRole('switch', { name: 'Quiet hours' }));
    await waitFor(() => expect(saved().quietHours).toEqual({ from: '18:00', to: '08:00' }));
    fireEvent.change(screen.getByLabelText('Quiet from'), { target: { value: '19:30' } });
    await waitFor(() => expect(saved().quietHours).toEqual({ from: '19:30', to: '08:00' }));
    fireEvent.click(screen.getByRole('switch', { name: 'Cards on the phone' }));
    await waitFor(() => expect(saved().phone).toBe(true));
    fireEvent.click(screen.getByRole('switch', { name: 'Prompt tips' }));
    await waitFor(() => expect(saved().tipTypes).toEqual({ prompt: false, thinkBigger: true }));
    fireEvent.click(screen.getByRole('switch', { name: '"Think bigger" tips' }));
    await waitFor(() => expect(saved().tipTypes).toEqual({ prompt: false, thinkBigger: false }));
    fireEvent.click(screen.getByRole('switch', { name: 'Weekly recap push notification' }));
    await waitFor(() => expect(saved().recap).toEqual({ inApp: true, push: true }));
    fireEvent.click(screen.getByRole('switch', { name: 'Weekly recap in the app' }));
    await waitFor(() => expect(saved().recap).toEqual({ inApp: false, push: true }));
    fireEvent.click(screen.getByRole('switch', { name: 'Show the five measures' }));
    await waitFor(() => expect(saved().showMeasures).toBe(false));
    // The caps are advanced.
    fireEvent.click(screen.getByRole('button', { name: 'Advanced' }));
    const day = screen.getByRole('spinbutton', { name: 'Most cards in a day' });
    fireEvent.change(day, { target: { value: '5' } }); fireEvent.blur(day);
    await waitFor(() => expect(saved().maxPerDay).toBe(5));
    const ses = screen.getByRole('spinbutton', { name: 'Most cards in one session' });
    fireEvent.change(ses, { target: { value: '2' } }); fireEvent.blur(ses);
    await waitFor(() => expect(saved().maxPerSession).toBe(2));
  });

  it('projects: one row names the pick and opens a checklist; an unticked project is left alone', async () => {
    const { saved } = await boot();
    fireEvent.click(screen.getByRole('button', { name: 'Projects: All projects' }));
    const panel = screen.getByRole('dialog', { name: 'Projects' });
    expect(within(panel).getByRole('checkbox', { name: 'Beta' })).toBeChecked();
    fireEvent.click(within(panel).getByRole('checkbox', { name: 'Beta' }));
    await waitFor(() => expect(saved().leaveAlone).toEqual(['s2']));
    expect(screen.getByRole('button', { name: 'Projects: 1 project' })).toBeInTheDocument();
    fireEvent.click(within(panel).getByRole('checkbox', { name: 'Beta' }));
    await waitFor(() => expect(saved().leaveAlone).toEqual([]));
  });

  it('projects: a left-alone id with no project stays; None leaves every project alone', async () => {
    const { saved } = await boot({ settings: { leaveAlone: ['gone'] } });
    fireEvent.click(screen.getByRole('button', { name: 'Projects: All projects' }));
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Projects' })).getByRole('button', { name: 'None' }));
    await waitFor(() => expect(saved().leaveAlone).toEqual(['gone', 's1', 's2']));
    expect(screen.getByRole('button', { name: 'Projects: No projects' })).toBeInTheDocument();
  });

  it('thoroughness and the model write their settings; a picked model has a harness and a model per tier', async () => {
    const { saved } = await boot();
    const th = screen.getByRole('radiogroup', { name: 'Thoroughness' });
    expect(within(th).getByRole('radio', { name: 'Balanced' })).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(within(th).getByRole('radio', { name: 'Fit budget' }));
    await waitFor(() => expect(saved().thoroughness).toBe('budget'));
    expect(screen.getByText(/fits your budget/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Advanced' }));
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Model' })).getByRole('radio', { name: 'Pick models' }));
    await waitFor(() => expect(saved().model).toEqual({ mode: 'pick', small: { harness: 'claude', model: 'claude-haiku-5-5' }, large: { harness: 'claude', model: 'opus' } }));
    pickOption('Large model harness', 'Codex');
    await waitFor(() => expect((saved().model as { large: unknown }).large).toEqual({ harness: 'codex', model: 'gpt-6.1-sol' }));
    const lm = screen.getByRole('textbox', { name: 'Large model' });
    fireEvent.change(lm, { target: { value: 'gpt-6.2-sol' } }); fireEvent.blur(lm);
    await waitFor(() => expect((saved().model as { large: unknown }).large).toEqual({ harness: 'codex', model: 'gpt-6.2-sol' }));
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Model' })).getByRole('radio', { name: 'Automatic' }));
    await waitFor(() => expect(saved().model).toEqual({ mode: 'auto' }));
  });

  it('the budget save calls the daemon', async () => {
    const { d, saved } = await boot();
    const pct = screen.getByRole('spinbutton', { name: 'Budget, percent of the weekly limit' });
    fireEvent.change(pct, { target: { value: '5' } }); fireEvent.blur(pct);
    await waitFor(() => expect(d.api.setPluginBudget).toHaveBeenCalledWith('coach', { percentWeekly: 5, usdWeekly: 5 }));
    expect(saved().budgetPercentWeekly).toBe(5);
    fireEvent.click(screen.getByRole('button', { name: 'Advanced' }));
    const usd = screen.getByRole('spinbutton', { name: 'OpenRouter budget, dollars a week' });
    fireEvent.change(usd, { target: { value: '12' } }); fireEvent.blur(usd);
    await waitFor(() => expect(d.api.setPluginBudget).toHaveBeenLastCalledWith('coach', { percentWeekly: 5, usdWeekly: 12 }));
    // Out of range is clamped to what the daemon takes (0.1 to 100).
    fireEvent.change(pct, { target: { value: '400' } }); fireEvent.blur(pct);
    await waitFor(() => expect(saved().budgetPercentWeekly).toBe(100));
  });

  it('Data opens the Coach screen, where the memory, goals and Reset live', async () => {
    const { d } = await boot();
    fireEvent.click(within(screen.getByRole('group', { name: 'Data' })).getByRole('button', { name: 'Open the Coach' }));
    expect(d.actions.setView).toHaveBeenCalledWith('plugin:coach:coach');
  });

  it('loading the Coach never writes the budget: the default is the daemon\'s (plugin.json), and an owner\'s "no cap" stays', async () => {
    const setPluginBudget = vi.fn(async () => ({ percentWeekly: null, usdWeekly: null }));
    await boot({ api: { pluginBudget: vi.fn(async () => ({ percentWeekly: null, usdWeekly: null })), setPluginBudget } });
    await new Promise((r) => setTimeout(r, 20));
    expect(setPluginBudget).not.toHaveBeenCalled();
  });

  it('Advanced shows every threshold with its default, and a change writes it', async () => {
    const { saved } = await boot();
    fireEvent.click(screen.getByRole('button', { name: 'Advanced' }));
    const adv = screen.getByTestId('coach-advanced');
    for (const [group, fields] of Object.entries(DEFAULT_THRESHOLDS)) {
      for (const [field, value] of Object.entries(fields as Record<string, number>)) {
        const input = within(adv).getByRole('spinbutton', { name: `${group} ${field}` });
        expect(input).toHaveValue(value);
        expect(within(adv).getByText(`default ${value}`, { selector: `[data-default="${group}.${field}"]` })).toBeInTheDocument();
      }
    }
    const idle = within(adv).getByRole('spinbutton', { name: 'idleWait minutes' });
    fireEvent.change(idle, { target: { value: '7' } }); fireEvent.blur(idle);
    await waitFor(() => expect(saved().advanced!.thresholds!.idleWait.minutes).toBe(7));
    const conf = within(adv).getByRole('spinbutton', { name: 'Show a card at this confidence or more' });
    expect(conf).toHaveValue(0.85);
    fireEvent.change(conf, { target: { value: '0.8' } }); fireEvent.blur(conf);
    await waitFor(() => expect(saved().advanced!.minConfidence).toBe(0.8));
  });
});
