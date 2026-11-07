import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react';
import { createCoach } from '../../../plugins/coach/web.js';
import { DEFAULT_THRESHOLDS } from '../../../plugins/coach/lib/settings.mjs';
import { emptyCadence } from '../../../plugins/coach/lib/cadence.mjs';
import { fakeD, type FakeD } from './coach-test-utils';

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

describe('Coach settings (coach plan Task 13)', () => {
  it('How often writes its setting, and says what each level does', async () => {
    const { saved } = await boot();
    const group = screen.getByRole('radiogroup', { name: 'How often' });
    expect(within(group).getByRole('radio', { name: 'Normal' })).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(within(group).getByRole('radio', { name: 'Chatty' }));
    await waitFor(() => expect(saved().howOften).toBe('chatty'));
    expect(screen.getByText(/Quiet: only the weekly recap and the right-column tab/)).toBeInTheDocument();
  });

  it('the caps, quiet hours, phone, tip types and the recap each write their setting', async () => {
    const { saved } = await boot();
    const day = screen.getByRole('spinbutton', { name: 'Most cards in a day' });
    fireEvent.change(day, { target: { value: '5' } }); fireEvent.blur(day);
    await waitFor(() => expect(saved().maxPerDay).toBe(5));
    const ses = screen.getByRole('spinbutton', { name: 'Most cards in one session' });
    fireEvent.change(ses, { target: { value: '2' } }); fireEvent.blur(ses);
    await waitFor(() => expect(saved().maxPerSession).toBe(2));
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
  });

  it('projects to leave alone are picked from the project list', async () => {
    const { saved } = await boot();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Leave alone: Beta' }));
    await waitFor(() => expect(saved().leaveAlone).toEqual(['s2']));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Leave alone: Beta' }));
    await waitFor(() => expect(saved().leaveAlone).toEqual([]));
  });

  it('thoroughness and the model write their settings; a picked model has a harness and a model per tier', async () => {
    const { saved } = await boot();
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Thoroughness' })).getByRole('radio', { name: 'Use my budget' }));
    await waitFor(() => expect(saved().thoroughness).toBe('budget'));
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Model' })).getByRole('radio', { name: 'Pick a harness and models' }));
    await waitFor(() => expect(saved().model).toEqual({ mode: 'pick', small: { harness: 'claude', model: 'claude-haiku-5-5' }, large: { harness: 'claude', model: 'opus' } }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Large model harness' }), { target: { value: 'codex' } });
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
    const usd = screen.getByRole('spinbutton', { name: 'OpenRouter budget, dollars a week' });
    fireEvent.change(usd, { target: { value: '12' } }); fireEvent.blur(usd);
    await waitFor(() => expect(d.api.setPluginBudget).toHaveBeenLastCalledWith('coach', { percentWeekly: 5, usdWeekly: 12 }));
    // Out of range is clamped to what the daemon takes (0.1 to 100).
    fireEvent.change(pct, { target: { value: '400' } }); fireEvent.blur(pct);
    await waitFor(() => expect(saved().budgetPercentWeekly).toBe(100));
  });

  it('a daemon with no budget gets the default one when the Coach loads', async () => {
    const setPluginBudget = vi.fn(async () => ({ percentWeekly: 3, usdWeekly: 5 }));
    await boot({ api: { pluginBudget: vi.fn(async () => ({ percentWeekly: null, usdWeekly: null })), setPluginBudget } });
    await waitFor(() => expect(setPluginBudget).toHaveBeenCalledWith('coach', { percentWeekly: 3, usdWeekly: 5 }));
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
    expect(conf).toHaveValue(0.7);
    fireEvent.change(conf, { target: { value: '0.8' } }); fireEvent.blur(conf);
    await waitFor(() => expect(saved().advanced!.minConfidence).toBe(0.8));
  });
});
