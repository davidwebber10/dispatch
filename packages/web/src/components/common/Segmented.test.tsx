import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, within, cleanup } from '@testing-library/react';
import { Segmented } from './Segmented';
import { SettingsGroup, SettingsRow } from '../settings/ui';

afterEach(() => cleanup());

describe('Segmented (the shared choice set for 2 to 5 options)', () => {
  const opts = [{ value: 'a', label: 'One', hint: 'The first.' }, { value: 'b', label: 'Two', hint: 'The second.' }, { value: 'c', label: 'Three' }];
  it('is a radiogroup; a click on another option calls onChange; the picked option\'s hint shows under it', () => {
    const onChange = vi.fn();
    render(<Segmented ariaLabel="Count" value="a" options={opts} onChange={onChange} />);
    const g = screen.getByRole('radiogroup', { name: 'Count' });
    expect(within(g).getByRole('radio', { name: 'One' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText('The first.')).toBeInTheDocument();
    expect(screen.queryByText('The second.')).toBeNull();
    fireEvent.click(within(g).getByRole('radio', { name: 'Two' }));
    expect(onChange).toHaveBeenCalledWith('b');
    fireEvent.click(within(g).getByRole('radio', { name: 'One' }));
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});

describe('SettingsGroup and SettingsRow (the grouped-card settings row)', () => {
  it('a group has its heading; a row has the label, the hint, a control on the right and a full-width part below', () => {
    render(
      <SettingsGroup title="Cost">
        <SettingsRow label="Budget" hint="A share of the weekly limit." control={<button type="button">ctl</button>}>
          <div data-testid="below">below</div>
        </SettingsRow>
        <SettingsRow label="Second" />
      </SettingsGroup>,
    );
    const g = screen.getByRole('group', { name: 'Cost' });
    expect(within(g).getByText('Cost')).toBeInTheDocument();
    expect(within(g).getByText('Budget')).toBeInTheDocument();
    expect(within(g).getByText('A share of the weekly limit.')).toBeInTheDocument();
    expect(within(g).getByRole('button', { name: 'ctl' })).toBeInTheDocument();
    expect(within(g).getByTestId('below')).toBeInTheDocument();
    expect(within(g).getAllByTestId('settings-row')).toHaveLength(2);
  });
});
