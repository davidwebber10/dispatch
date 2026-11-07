import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { ModelControl, modelControlLabel, pickerModels, type ModelControlProps } from './ModelPicker';
import { usePickerRequest } from '../../stores/pickerRequest';

let onApply: ReturnType<typeof vi.fn>;
beforeEach(() => { onApply = vi.fn().mockResolvedValue('Changed. Applies from the next turn.'); usePickerRequest.getState().clear(); });

const props = (over: Partial<ModelControlProps> = {}): ModelControlProps => ({
  owner: 'thread:t1', harness: 'claude-code', model: null, effort: null, liveModel: 'claude-sonnet-5-5', mobile: false, onApply: onApply as never, ...over,
});

describe('modelControlLabel', () => {
  it('shows the live model when nothing is saved, and adds the effort', () => {
    expect(modelControlLabel(props())).toBe('Sonnet 5.5');
    expect(modelControlLabel(props({ effort: 'high' }))).toBe('Sonnet 5.5 · high');
  });
  it('shows the saved choice: the live version when the family matches, else the catalog name', () => {
    expect(modelControlLabel(props({ model: 'sonnet' }))).toBe('Sonnet 5.5');
    expect(modelControlLabel(props({ model: 'opus' }))).toBe('Opus'); // saved now, live next turn
    expect(modelControlLabel(props({ harness: 'codex', model: 'gpt-6-astra', liveModel: 'gpt-5.6-sol' }))).toBe('6 Astra');
    expect(modelControlLabel(props({ harness: 'codex', model: 'gpt-6-luna' }))).toBe('gpt-6-luna'); // not in the catalog: shown whole
    expect(modelControlLabel(props({ harness: 'codex', model: null, liveModel: 'gpt-5.6-sol' }))).toBe('5.6 Sol');
  });
  it('falls back to the default model (Chat) and to "Model"', () => {
    expect(modelControlLabel(props({ liveModel: undefined, defaultModel: 'opus' }))).toBe('Opus');
    expect(modelControlLabel(props({ liveModel: undefined }))).toBe('Model');
  });
});

describe('pickerModels', () => {
  it('is the New Thread catalog; Codex has no Default row', () => {
    expect(pickerModels('claude-code').map((m) => m.model)).toEqual([null, 'fable', 'opus', 'sonnet', 'haiku']);
    expect(pickerModels('codex').every((m) => m.model !== null)).toBe(true);
  });
});

describe('ModelControl', () => {
  it('opens from the model name, lists models and effort, and says when it applies', () => {
    render(<ModelControl {...props({ model: 'opus', effort: 'high' })} />);
    fireEvent.click(screen.getByRole('button', { name: /Opus/ }));
    const dialog = screen.getByRole('dialog', { name: 'Model and effort' });
    expect(dialog).toHaveTextContent('Applies from the next turn.');
    expect(screen.getByRole('button', { name: 'Opus', pressed: true })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'high', pressed: true })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { pressed: false }).map((b) => b.textContent)).toEqual(expect.arrayContaining(['Default', 'Fable', 'Sonnet', 'Haiku', 'low', 'medium', 'xhigh', 'max']));
  });

  it('choosing a model or an effort calls onApply with just that change and shows the note', async () => {
    render(<ModelControl {...props()} />);
    fireEvent.click(screen.getByRole('button', { name: /Sonnet/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Haiku' }));
    await waitFor(() => expect(onApply).toHaveBeenCalledWith({ model: 'haiku' }));
    fireEvent.click(screen.getByRole('button', { name: 'max' }));
    await waitFor(() => expect(onApply).toHaveBeenLastCalledWith({ effort: 'max' }));
    expect(screen.getByRole('status')).toHaveTextContent('Changed. Applies from the next turn.');
  });

  it('Default sends model null', async () => {
    render(<ModelControl {...props({ model: 'opus' })} />);
    fireEvent.click(screen.getByRole('button', { name: /Opus/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Default' }));
    await waitFor(() => expect(onApply).toHaveBeenCalledWith({ model: null }));
  });

  it('shows the daemon\'s plain reason when the change is refused', async () => {
    onApply.mockRejectedValueOnce(new Error("Model 'x' not found"));
    render(<ModelControl {...props()} />);
    fireEvent.click(screen.getByRole('button', { name: /Sonnet/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Fable' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent("Model 'x' not found"));
  });

  it('Escape closes it', () => {
    render(<ModelControl {...props()} />);
    fireEvent.click(screen.getByRole('button', { name: /Sonnet/ }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('Codex has no Default model row, and offers the efforts it is given for the model (Luna: no ultra)', () => {
    render(<ModelControl {...props({ harness: 'codex', model: 'gpt-6-luna', liveModel: 'gpt-6-luna', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] })} />);
    fireEvent.click(screen.getByRole('button', { name: 'gpt-6-luna' }));
    expect(screen.queryByRole('button', { name: 'Default' })).toBeNull();
    expect(screen.getByRole('button', { name: 'max' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'ultra' })).toBeNull();
  });

  it('Codex with no per-model list offers every effort any model takes', () => {
    render(<ModelControl {...props({ harness: 'codex', model: 'gpt-6-astra', liveModel: 'gpt-6-astra' })} />);
    fireEvent.click(screen.getByRole('button', { name: /Astra/ }));
    expect(screen.getByRole('button', { name: 'ultra' })).toBeInTheDocument();
  });

  it('Chat: the Default row names the model that runs', () => {
    render(<ModelControl {...props({ owner: 'chat', liveModel: undefined, defaultModel: 'opus' })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Opus' }));
    expect(screen.getByRole('button', { name: 'Default (Opus)', pressed: true })).toBeInTheDocument();
  });

  it('a harness that cannot change yet shows the name as text, with the reason', () => {
    render(<ModelControl {...props({ harness: 'grok', liveModel: 'grok-4', disabledReason: 'Not available yet' })} />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByTitle('Not available yet')).toHaveTextContent('Grok 4');
  });

  it('the "/" menu opens it by owner, once, and only for its own owner', () => {
    render(<ModelControl {...props()} />);
    act(() => usePickerRequest.getState().request('chat'));
    expect(screen.queryByRole('dialog')).toBeNull();
    act(() => usePickerRequest.getState().request('thread:t1'));
    expect(screen.getByRole('dialog', { name: 'Model and effort' })).toBeInTheDocument();
    expect(usePickerRequest.getState().owner).toBeNull();
  });
});
