import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';
import { AgentsSection } from './AgentsSection';
import { api } from '../../api/client';

const MODELS = [
  { label: 'Claude Opus', model: 'openrouter/~anthropic/claude-opus-latest' },
  { label: 'Kimi', model: 'openrouter/~moonshotai/kimi-latest' },
];

const response = (over: Partial<{ settings: Record<string, unknown>; opencodeModels: typeof MODELS }> = {}) => ({
  settings: {},
  opencodeKey: { secret: 'OPENROUTER_API_KEY', present: true },
  opencodeModels: MODELS,
  ...over,
});

vi.mock('../../api/client', () => ({
  api: {
    getHarnessSettings: vi.fn(),
    putHarnessSettings: vi.fn(),
    listSecrets: vi.fn().mockResolvedValue([{ name: 'OPENROUTER_API_KEY', value: '' }]),
    setSecret: vi.fn(),
    searchOpencodeCatalog: vi.fn().mockResolvedValue([]),
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  // clearAllMocks keeps implementations, so the outage test's rejecting mock must be undone here.
  (api.searchOpencodeCatalog as any).mockResolvedValue([]);
  (api.getHarnessSettings as any).mockResolvedValue(response());
  (api.putHarnessSettings as any).mockImplementation(async (patch: any) => {
    const models = patch.opencode?.models;
    return response({ opencodeModels: models === null ? MODELS.slice(0, 1) : models ?? MODELS });
  });
});

/** Opens a harness's own page from its row on the Agents list (2026-11-07 redesign). */
const openHarness = async (label: string, id: string) => {
  fireEvent.click(await screen.findByRole('button', { name: label }));
  return screen.findByTestId(`agent-detail-${id}`);
};
const opencodeCard = () => openHarness('OpenCode', 'opencode');

describe('AgentsSection — the list (2026-11-07 redesign)', () => {
  it('shows one row per harness with its default model as the value, and no model list on the page', async () => {
    (api.getHarnessSettings as any).mockResolvedValue(response({ settings: { 'claude-code': { defaultModel: 'opus', defaultMode: 'pretty' } } }));
    render(<AgentsSection />);
    for (const name of ['Claude Code', 'Codex', 'Grok', 'OpenCode']) expect(await screen.findByRole('button', { name })).toBeInTheDocument();
    const claude = screen.getByRole('button', { name: 'Claude Code' });
    expect(claude).toHaveTextContent('Opus');
    expect(claude).toHaveTextContent('Pretty');
    expect(screen.getByRole('button', { name: 'OpenCode' })).toHaveTextContent('Claude Opus');
    expect(screen.queryByRole('list', { name: 'OpenCode models' })).toBeNull();
    expect(screen.queryByRole('switch', { name: 'Skip agent status summaries' })).toBeNull();
  });

  it('a harness page opens from its row and its back link returns to the list', async () => {
    render(<AgentsSection />);
    const page = await openHarness('Codex', 'codex');
    expect(within(page).getByTestId('subpage-header')).toHaveTextContent('Codex');
    expect(screen.queryByRole('button', { name: 'Grok' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Back to agents' }));
    expect(await screen.findByRole('button', { name: 'Grok' })).toBeInTheDocument();
  });

  it('on a phone the page is a history entry: back (popstate) closes it, and the page has no back link of its own', async () => {
    const width = window.innerWidth;
    const mm = window.matchMedia;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
    window.matchMedia = ((q: string) => ({ matches: true, media: q, addEventListener() {}, removeEventListener() {} })) as any;
    history.replaceState({ nav: 1, settingsSection: 'agents', depth: 1 }, '');
    try {
      render(<AgentsSection />);
      await openHarness('Grok', 'grok');
      expect(history.state).toMatchObject({ nav: 1, settingsSection: 'agents', depth: 2, subPage: 'grok', subTitle: 'Grok' });
      expect(screen.queryByRole('button', { name: 'Back to agents' })).toBeNull();
      history.replaceState({ nav: 1, settingsSection: 'agents', depth: 1 }, '');
      act(() => { window.dispatchEvent(new PopStateEvent('popstate', { state: { nav: 1, settingsSection: 'agents', depth: 1 } })); });
      expect(await screen.findByRole('button', { name: 'Grok' })).toBeInTheDocument();
    } finally {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
      window.matchMedia = mm;
    }
  });

  it('the default mode is a segmented choice that saves the mode, and No preference clears it', async () => {
    render(<AgentsSection />);
    const page = await openHarness('Claude Code', 'claude');
    fireEvent.click(within(page).getByRole('radio', { name: 'Pretty' }));
    await waitFor(() => expect(api.putHarnessSettings).toHaveBeenCalledWith({ 'claude-code': { defaultMode: 'pretty' } }));
  });

  it('a one-mode harness has no default mode choice', async () => {
    render(<AgentsSection />);
    const page = await openHarness('Grok', 'grok');
    expect(within(page).queryByRole('radiogroup', { name: 'Default mode' })).toBeNull();
  });

  it('saves a replacement OpenRouter key to the chosen Doppler secret', async () => {
    (api.setSecret as any).mockResolvedValue(undefined);
    render(<AgentsSection />);
    const page = await opencodeCard();
    fireEvent.change(within(page).getByLabelText('New OpenRouter key'), { target: { value: ' sk-or-v1-abc ' } });
    fireEvent.click(within(page).getByRole('button', { name: 'Save key' }));
    await waitFor(() => expect(api.setSecret).toHaveBeenCalledWith({ name: 'OPENROUTER_API_KEY', value: 'sk-or-v1-abc' }));
  });
});

describe('AgentsSection — OpenCode model list', () => {
  it('lists the configured models, with their ids, and offers them as the default model', async () => {
    render(<AgentsSection />);
    const card = await opencodeCard();
    const list = within(card).getByRole('list', { name: 'OpenCode models' });
    expect(within(list).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'Claude Opus~anthropic/claude-opus-latest',
      'Kimi~moonshotai/kimi-latest',
    ]);
    fireEvent.click(within(card).getByRole('combobox', { name: 'Default model' }));
    expect(within(screen.getByRole('listbox')).getAllByRole('option').map((o) => o.textContent)).toEqual(['List default (Claude Opus)', 'Claude Opus', 'Kimi']);
  });

  it('removing a model saves the list without it', async () => {
    render(<AgentsSection />);
    const card = await opencodeCard();
    fireEvent.click(within(card).getByRole('button', { name: 'Remove Kimi' }));
    await waitFor(() => expect(api.putHarnessSettings).toHaveBeenCalledWith({ opencode: { models: [MODELS[0]] } }));
    await waitFor(() => expect(within(card).queryByText('Kimi')).not.toBeInTheDocument());
  });

  it('removing the model that is the default also clears the default', async () => {
    (api.getHarnessSettings as any).mockResolvedValue(response({ settings: { opencode: { defaultModel: MODELS[1].model } } }));
    render(<AgentsSection />);
    const card = await opencodeCard();
    fireEvent.click(within(card).getByRole('button', { name: 'Remove Kimi' }));
    await waitFor(() => expect(api.putHarnessSettings).toHaveBeenCalledWith({ opencode: { models: [MODELS[0]], defaultModel: null } }));
  });

  it('searches the catalog and adds a pick to the end of the list', async () => {
    (api.searchOpencodeCatalog as any).mockResolvedValue([
      { id: 'openrouter/~x-ai/grok-latest', label: 'Grok Latest', name: 'xAI: Grok Latest', contextLength: 500000, created: 2, alias: true, aliasTarget: 'x-ai/grok-4.6' },
      { id: 'openrouter/~moonshotai/kimi-latest', label: 'Kimi Latest', name: 'MoonshotAI: Kimi Latest', contextLength: 1048576, created: 1, alias: true },
    ]);
    render(<AgentsSection />);
    const card = await opencodeCard();
    fireEvent.change(within(card).getByRole('textbox', { name: 'Add a model' }), { target: { value: 'grok' } });
    await waitFor(() => expect(api.searchOpencodeCatalog).toHaveBeenCalledWith('grok'));
    const results = await within(card).findByRole('list', { name: 'Catalog results' });
    // One already in the list reads as added and cannot be added twice.
    expect(within(results).getByText('Kimi Latest').closest('li')).toHaveTextContent('Added');
    fireEvent.click(within(results).getByRole('button', { name: 'Add Grok Latest' }));
    await waitFor(() => expect(api.putHarnessSettings).toHaveBeenCalledWith({
      opencode: { models: [...MODELS, { label: 'Grok Latest', model: 'openrouter/~x-ai/grok-latest' }] },
    }));
    expect(within(card).getByRole('list', { name: 'OpenCode models' })).toHaveTextContent('Grok Latest');
  });

  it('marks a catalog model that has no tool-capable endpoint as chat only, and still lets it be added', async () => {
    (api.searchOpencodeCatalog as any).mockResolvedValue([
      { id: 'openrouter/cognitivecomputations/dolphin-mistral-24b-venice-edition', label: 'Uncensored', name: 'Venice: Uncensored', contextLength: 128000, created: 3, alias: false, tools: false },
      { id: 'openrouter/~x-ai/grok-latest', label: 'Grok Latest', name: 'xAI: Grok Latest', contextLength: 500000, created: 2, alias: true, aliasTarget: 'x-ai/grok-4.6', tools: true },
    ]);
    render(<AgentsSection />);
    const card = await opencodeCard();
    fireEvent.change(within(card).getByRole('textbox', { name: 'Add a model' }), { target: { value: 'venice' } });
    const results = await within(card).findByRole('list', { name: 'Catalog results' });
    expect((await within(results).findByText('Uncensored')).closest('li')).toHaveTextContent('Chat only');
    expect(within(results).getByText('Grok Latest').closest('li')).not.toHaveTextContent('Chat only');
    fireEvent.click(within(results).getByRole('button', { name: 'Add Uncensored' }));
    await waitFor(() => expect(api.putHarnessSettings).toHaveBeenCalledWith({
      opencode: { models: [...MODELS, { label: 'Uncensored', model: 'openrouter/cognitivecomputations/dolphin-mistral-24b-venice-edition' }] },
    }));
  });

  it('shows the catalog outage instead of an empty result', async () => {
    (api.searchOpencodeCatalog as any).mockRejectedValue(new Error('Could not reach the OpenRouter catalog: ENOTFOUND'));
    render(<AgentsSection />);
    const card = await opencodeCard();
    fireEvent.change(within(card).getByRole('textbox', { name: 'Add a model' }), { target: { value: 'grok' } });
    expect(await within(card).findByText(/Could not reach the OpenRouter catalog/)).toBeInTheDocument();
  });

  it('offers to add a typed id when the catalog has no match for it', async () => {
    render(<AgentsSection />);
    const card = await opencodeCard();
    fireEvent.change(within(card).getByRole('textbox', { name: 'Add a model' }), { target: { value: 'openrouter/acme/model-9' } });
    fireEvent.click(await within(card).findByRole('button', { name: 'Add openrouter/acme/model-9 as typed' }));
    await waitFor(() => expect(api.putHarnessSettings).toHaveBeenCalledWith({
      opencode: { models: [...MODELS, { label: 'acme/model-9', model: 'openrouter/acme/model-9' }] },
    }));
  });

  it('reset restores the daemon defaults', async () => {
    render(<AgentsSection />);
    const card = await opencodeCard();
    fireEvent.click(within(card).getByRole('button', { name: 'Reset to defaults' }));
    await waitFor(() => expect(api.putHarnessSettings).toHaveBeenCalledWith({ opencode: { models: null } }));
  });
});

describe('AgentsSection — Claude Code agent status summaries', () => {
  it('shows the skip switch on by default, and turning it off saves false', async () => {
    render(<AgentsSection />);
    await openHarness('Claude Code', 'claude');
    const sw = await screen.findByRole('switch', { name: 'Skip agent status summaries' });
    expect(sw).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(sw);
    await waitFor(() => expect(api.putHarnessSettings).toHaveBeenCalledWith({ 'claude-code': { skipAgentSummaries: false } }));
  });

  it('reflects a stored off', async () => {
    (api.getHarnessSettings as any).mockResolvedValue(response({ settings: { 'claude-code': { skipAgentSummaries: false } } }));
    render(<AgentsSection />);
    await openHarness('Claude Code', 'claude');
    expect(await screen.findByRole('switch', { name: 'Skip agent status summaries' })).toHaveAttribute('aria-checked', 'false');
  });
});

describe('AgentsSection — Control Plane name (moved from General)', () => {
  it('edits the coordinator name in the shared store', async () => {
    const { useSettings } = await import('../../stores/settings');
    useSettings.setState({ coordinatorName: 'Control Plane' });
    render(<AgentsSection />);
    fireEvent.change(screen.getByLabelText('Control Plane name'), { target: { value: 'Mission Control' } });
    expect(useSettings.getState().coordinatorName).toBe('Mission Control');
  });

  it('uses the shared switch for the per-harness auto-archive default', async () => {
    render(<AgentsSection />);
    const card = await opencodeCard();
    const sw = within(card).getByRole('switch', { name: 'Auto-archive thread' });
    expect(sw.tagName).toBe('BUTTON');
    fireEvent.click(sw);
    await waitFor(() => expect(api.putHarnessSettings).toHaveBeenCalledWith({ opencode: { autoArchiveMs: 12 * 3_600_000 } }));
  });
});
