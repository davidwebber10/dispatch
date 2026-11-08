import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ModelSwitcher, ModelNotice } from './ModelSwitcher';
import { api } from '../../../api/client';
import { useActiveModel } from '../../../stores/activeModel';
import { useTabs } from '../../../stores/tabs';
import type { Terminal } from '../../../api/types';

vi.mock('../../../api/client', () => ({
  api: {
    setThreadModel: vi.fn(),
    getHarnessSettings: vi.fn().mockResolvedValue({ settings: {}, opencodeModels: [{ label: 'Kimi K3', model: 'openrouter/moonshotai/kimi-k3' }] }),
  },
}));

const tab = (over: Partial<Terminal> = {}): Terminal => ({ id: 't1', sessionId: 's1', type: 'claude-code', label: 'T', pid: 1, externalId: 'e1', workingDir: null, status: 'waiting', createdAt: '', config: { transport: 'structured', model: 'opus' }, archivedAt: null, sortOrder: 0, ...over });

beforeEach(() => {
  vi.clearAllMocks();
  useActiveModel.setState({ byTerminal: {} });
  useTabs.setState({ byProject: { s1: [tab()] } } as any);
  vi.spyOn(useTabs.getState(), 'loadTabs').mockResolvedValue(undefined as any);
});

describe('ModelSwitcher', () => {
  it('shows the saved model before the harness reports one, then the reported one', () => {
    const { rerender } = render(<ModelSwitcher tab={tab()} busy={false} />);
    expect(screen.getByRole('button', { name: /Model: Opus/ })).toBeInTheDocument();
    useActiveModel.getState().set('t1', 'claude-opus-5-5');
    rerender(<ModelSwitcher tab={tab()} busy={false} />);
    expect(screen.getByRole('button', { name: /Model: Opus 5.5/ })).toBeInTheDocument();
  });

  it('opens the harness list, marks the running model, and switches on a pick', async () => {
    useActiveModel.getState().set('t1', 'claude-opus-5-5');
    (api.setThreadModel as any).mockResolvedValue({ model: 'claude-haiku-5-5', terminal: tab({ config: { transport: 'structured', model: 'haiku' } }) });
    render(<ModelSwitcher tab={tab()} busy={false} />);
    fireEvent.click(screen.getByRole('button', { name: /Model:/ }));
    const opus = await screen.findByRole('radio', { name: /Opus/ });
    expect(opus).toHaveAttribute('aria-checked', 'true');
    expect(screen.getAllByRole('radio').map((r) => r.textContent)).toEqual(expect.arrayContaining([expect.stringContaining('Fable'), expect.stringContaining('Haiku')]));
    fireEvent.click(screen.getByRole('radio', { name: /Haiku/ }));
    await waitFor(() => expect(api.setThreadModel).toHaveBeenCalledWith('t1', 'haiku'));
    await waitFor(() => expect(useActiveModel.getState().byTerminal.t1).toBe('claude-haiku-5-5'));
    await waitFor(() => expect(screen.queryByRole('radio')).toBeNull()); // closed
  });

  it('is disabled while a turn runs, and says why', () => {
    render(<ModelSwitcher tab={tab()} busy />);
    const btn = screen.getByRole('button', { name: /Model:/ });
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute('title', expect.stringMatching(/turn ends/));
  });

  it('shows the harness error and keeps the list open', async () => {
    (api.setThreadModel as any).mockRejectedValue(new Error('Unknown model'));
    render(<ModelSwitcher tab={tab()} busy={false} />);
    fireEvent.click(screen.getByRole('button', { name: /Model:/ }));
    fireEvent.click(await screen.findByRole('radio', { name: /Sonnet/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Unknown model');
    expect(screen.getAllByRole('radio').length).toBeGreaterThan(0);
  });

  it('an OpenCode thread lists the user models', async () => {
    const t = tab({ type: 'opencode', config: { model: 'openrouter/moonshotai/kimi-k3' } });
    render(<ModelSwitcher tab={t} busy={false} />);
    await waitFor(() => expect(screen.getByRole('button', { name: /Model: Kimi K3/ })).toBeInTheDocument());
  });

  it('a thread with no model known yet reads "Default model"', () => {
    render(<ModelSwitcher tab={tab({ config: { transport: 'structured' } })} busy={false} />);
    expect(screen.getByRole('button', { name: /Model: Default/ })).toBeInTheDocument();
  });
});

describe('ModelNotice', () => {
  it('names the new model in words', () => {
    render(<ModelNotice model="claude-haiku-5-5" />);
    expect(screen.getByText('Model switched to Haiku 4.5'.replace('4.5', '5.5'))).toBeInTheDocument();
  });
});
