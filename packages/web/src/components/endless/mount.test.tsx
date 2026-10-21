import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { useUI, loadView } from '../../stores/ui';
import { IconRail } from '../layout/IconRail';

describe('Chat mode mounting', () => {
  it('offers a Chat item in the icon rail', () => {
    render(<IconRail />);
    expect(screen.getByRole('button', { name: 'Chat' })).toBeTruthy();
  });
  it('persists and restores the chat view', () => {
    useUI.getState().setView('chat');
    expect(localStorage.getItem('dispatch:view')).toBe('chat');
    expect(loadView()).toBe('chat');
  });
});
