import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { HarnessesSection } from './HarnessesSection';
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

/** The OpenCode card, found by its heading. */
const opencodeCard = async () => (await screen.findByText('OPENCODE')).parentElement as HTMLElement;

describe('HarnessesSection — OpenCode model list', () => {
  it('lists the configured models, with their ids, and offers them as the default model', async () => {
    render(<HarnessesSection />);
    const card = await opencodeCard();
    const list = within(card).getByRole('list', { name: 'OpenCode models' });
    expect(within(list).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'Claude Opus~anthropic/claude-opus-latest',
      'Kimi~moonshotai/kimi-latest',
    ]);
    const def = within(card).getByLabelText('Default model') as HTMLSelectElement;
    expect(Array.from(def.options).map((o) => o.text)).toEqual(['List default (Claude Opus)', 'Claude Opus', 'Kimi']);
  });

  it('removing a model saves the list without it', async () => {
    render(<HarnessesSection />);
    const card = await opencodeCard();
    fireEvent.click(within(card).getByRole('button', { name: 'Remove Kimi' }));
    await waitFor(() => expect(api.putHarnessSettings).toHaveBeenCalledWith({ opencode: { models: [MODELS[0]] } }));
    await waitFor(() => expect(within(card).queryByText('Kimi')).not.toBeInTheDocument());
  });

  it('removing the model that is the default also clears the default', async () => {
    (api.getHarnessSettings as any).mockResolvedValue(response({ settings: { opencode: { defaultModel: MODELS[1].model } } }));
    render(<HarnessesSection />);
    const card = await opencodeCard();
    fireEvent.click(within(card).getByRole('button', { name: 'Remove Kimi' }));
    await waitFor(() => expect(api.putHarnessSettings).toHaveBeenCalledWith({ opencode: { models: [MODELS[0]], defaultModel: null } }));
  });

  it('searches the catalog and adds a pick to the end of the list', async () => {
    (api.searchOpencodeCatalog as any).mockResolvedValue([
      { id: 'openrouter/~x-ai/grok-latest', label: 'Grok Latest', name: 'xAI: Grok Latest', contextLength: 500000, created: 2, alias: true, aliasTarget: 'x-ai/grok-4.6' },
      { id: 'openrouter/~moonshotai/kimi-latest', label: 'Kimi Latest', name: 'MoonshotAI: Kimi Latest', contextLength: 1048576, created: 1, alias: true },
    ]);
    render(<HarnessesSection />);
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

  it('shows the catalog outage instead of an empty result', async () => {
    (api.searchOpencodeCatalog as any).mockRejectedValue(new Error('Could not reach the OpenRouter catalog: ENOTFOUND'));
    render(<HarnessesSection />);
    const card = await opencodeCard();
    fireEvent.change(within(card).getByRole('textbox', { name: 'Add a model' }), { target: { value: 'grok' } });
    expect(await within(card).findByText(/Could not reach the OpenRouter catalog/)).toBeInTheDocument();
  });

  it('offers to add a typed id when the catalog has no match for it', async () => {
    render(<HarnessesSection />);
    const card = await opencodeCard();
    fireEvent.change(within(card).getByRole('textbox', { name: 'Add a model' }), { target: { value: 'openrouter/acme/model-9' } });
    fireEvent.click(await within(card).findByRole('button', { name: 'Add openrouter/acme/model-9 as typed' }));
    await waitFor(() => expect(api.putHarnessSettings).toHaveBeenCalledWith({
      opencode: { models: [...MODELS, { label: 'acme/model-9', model: 'openrouter/acme/model-9' }] },
    }));
  });

  it('reset restores the daemon defaults', async () => {
    render(<HarnessesSection />);
    const card = await opencodeCard();
    fireEvent.click(within(card).getByRole('button', { name: 'Reset to defaults' }));
    await waitFor(() => expect(api.putHarnessSettings).toHaveBeenCalledWith({ opencode: { models: null } }));
  });
});
