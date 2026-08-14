import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { useUI, loadView } from '../../stores/ui';
import { TopBar } from '../layout/TopBar';

describe('analytics mounting', () => {
  it('offers an Analytics segment in the top bar', () => {
    render(<TopBar />);
    expect(screen.getByRole('button', { name: 'Analytics' })).toBeTruthy();
  });

  it('setView writes analytics to localStorage', () => {
    useUI.getState().setView('analytics');
    expect(useUI.getState().view).toBe('analytics');
    expect(localStorage.getItem('dispatch:view')).toBe('analytics');
  });

  it('loadView reads a persisted analytics value back, instead of resetting to workspace', () => {
    localStorage.setItem('dispatch:view', 'analytics');
    expect(loadView()).toBe('analytics');
  });

  it('loadView falls back to workspace for an unrecognised persisted value', () => {
    localStorage.setItem('dispatch:view', 'nonsense');
    expect(loadView()).toBe('workspace');
  });
});
