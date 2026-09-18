import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { SearchSelect } from './SearchSelect';

const OPTS = [
  { value: '', label: 'Default' },
  { value: 'opus', label: 'Opus', hint: 'anthropic/claude-opus-latest' },
  { value: 'sonnet', label: 'Sonnet', hint: 'anthropic/claude-sonnet-latest' },
  { value: 'glm', label: 'GLM', hint: 'z-ai/glm-latest' },
];

function setup(value = '', onChange = vi.fn()) {
  render(<SearchSelect value={value} options={OPTS} onChange={onChange} ariaLabel="Model" />);
  return { onChange, trigger: screen.getByRole('combobox', { name: 'Model' }) };
}

describe('SearchSelect', () => {
  it('reads like a select: the trigger shows the current label and is closed by default', () => {
    const { trigger } = setup('sonnet');
    expect(trigger).toHaveTextContent('Sonnet');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('opens on click with a search box and every option, the current one selected', () => {
    const { trigger } = setup('sonnet');
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('textbox', { name: 'Search model' })).toBeInTheDocument();
    const list = screen.getByRole('listbox', { name: 'Model' });
    expect(within(list).getAllByRole('option')).toHaveLength(4);
    expect(within(list).getByRole('option', { name: /Sonnet/ })).toHaveAttribute('aria-selected', 'true');
  });

  it('typing filters by label, value, or hint', () => {
    setup();
    fireEvent.click(screen.getByRole('combobox', { name: 'Model' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Search model' }), { target: { value: 'z-ai' } });
    const opts = screen.getAllByRole('option');
    expect(opts).toHaveLength(1);
    expect(opts[0]).toHaveTextContent('GLM');
    fireEvent.change(screen.getByRole('textbox', { name: 'Search model' }), { target: { value: 'zzz' } });
    expect(screen.queryAllByRole('option')).toHaveLength(0);
    expect(screen.getByText('No matches')).toBeInTheDocument();
  });

  it('clicking an option reports its value and closes', () => {
    const { onChange, trigger } = setup();
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('option', { name: /Opus/ }));
    expect(onChange).toHaveBeenCalledWith('opus');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('arrow keys move the cursor from the current value and Enter picks', () => {
    const { onChange, trigger } = setup('opus');
    fireEvent.click(trigger);
    const input = screen.getByRole('textbox', { name: 'Search model' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('sonnet');
  });

  it('Escape closes the popover without reaching the document (the modal must stay open)', () => {
    const docEsc = vi.fn();
    document.addEventListener('keydown', docEsc);
    const { trigger } = setup();
    fireEvent.click(trigger);
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Search model' }), { key: 'Escape' });
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(docEsc).not.toHaveBeenCalled();
    document.removeEventListener('keydown', docEsc);
  });

  it('an outside mousedown closes it', () => {
    const { trigger } = setup();
    fireEvent.click(trigger);
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('keeps the options open while scrolling inside, but closes on page scroll', () => {
    const { trigger } = setup();
    fireEvent.click(trigger);
    fireEvent.scroll(screen.getByRole('listbox'));
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    fireEvent.scroll(window);
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('a disabled select never opens', () => {
    render(<SearchSelect value="" options={OPTS} onChange={() => {}} ariaLabel="Model" disabled />);
    fireEvent.click(screen.getByRole('combobox', { name: 'Model' }));
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });
});
