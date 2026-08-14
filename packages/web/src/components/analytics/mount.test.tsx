import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { useUI } from '../../stores/ui';
import { TopBar } from '../layout/TopBar';

describe('analytics mounting', () => {
  it('offers an Analytics segment in the top bar', () => {
    render(<TopBar />);
    expect(screen.getByRole('button', { name: 'Analytics' })).toBeTruthy();
  });

  it('accepts analytics as a view and persists it', () => {
    useUI.getState().setView('analytics');
    expect(useUI.getState().view).toBe('analytics');
    expect(localStorage.getItem('dispatch:view')).toBe('analytics');
  });
});
