import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Kpi } from './parts';

describe('Kpi', () => {
  it('renders only the label and the value when no caption or info is given', () => {
    render(<Kpi label="TURNS" value="12" />);
    expect(screen.getByText('TURNS').parentElement!.textContent).toBe('TURNS12');
  });

  it('renders a caption under the value, and an info mark that carries its text', () => {
    render(<Kpi label="MISSIONS COMPLETED" value="11" caption="since Aug 15" info="No working or queued agent, and no activity for 7 days." />);
    expect(screen.getByText('since Aug 15')).toBeTruthy();
    expect(screen.getByLabelText('No working or queued agent, and no activity for 7 days.').getAttribute('title'))
      .toBe('No working or queued agent, and no activity for 7 days.');
    expect(screen.getByLabelText('No working or queued agent, and no activity for 7 days.').getAttribute('tabindex')).toBe('0');
  });
});
