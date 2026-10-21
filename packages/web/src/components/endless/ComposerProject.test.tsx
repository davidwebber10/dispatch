import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';
import { Composer } from './EndlessColumn';
import { ProjectsPanel } from './ProjectsPanel';
import { useEndless } from '../../stores/endless';
import { useProjects } from '../../stores/projects';
import { api } from '../../api/client';
import type { Session } from '../../api/types';

let savedEndless: ReturnType<typeof useEndless.getState>;
let savedProjects: ReturnType<typeof useProjects.getState>;

const sess = (id: string, name: string, lastActivityAt: string) => ({ id, name, lastActivityAt }) as unknown as Session;

beforeEach(() => {
  localStorage.clear(); // drafts persist in local storage; each case starts with none
  savedEndless = useEndless.getState();
  savedProjects = useProjects.getState();
  useProjects.setState({ sessions: [sess('s1', 'salsify', '2026-10-01T00:00:00Z'), sess('s2', 'recent', '2026-10-10T00:00:00Z')] });
  useEndless.setState({ filter: null, projects: [] });
});

afterEach(() => {
  vi.restoreAllMocks();
  act(() => {
    useEndless.setState(savedEndless, true);
    useProjects.setState(savedProjects, true);
  });
});

const open = () => fireEvent.click(screen.getByRole('button', { name: 'Choose project' }));

describe('Composer project picker', () => {
  it('opens a menu of projects, most recent first, and picking one shows a pill', () => {
    render(<Composer />);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    open();
    const items = within(screen.getByRole('menu')).getAllByRole('menuitemradio');
    expect(items.map((i) => i.textContent)).toEqual(['recent', 'salsify']);
    fireEvent.click(items[1]);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(screen.getByTestId('project-pill')).toHaveTextContent('salsify');
    open();
    expect(screen.getByRole('menuitemradio', { name: 'salsify' })).toHaveAttribute('aria-checked', 'true');
  });

  it('the x removes the pill', () => {
    render(<Composer />);
    open();
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'recent' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove project' }));
    expect(screen.queryByTestId('project-pill')).not.toBeInTheDocument();
  });

  it('Escape closes the menu and an outside click closes it', () => {
    render(<Composer />);
    open();
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    open();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('arrow keys move and Enter selects', () => {
    render(<Composer />);
    open();
    const menu = screen.getByRole('menu');
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    fireEvent.keyDown(menu, { key: 'Enter' });
    expect(screen.getByTestId('project-pill')).toHaveTextContent('salsify');
  });

  it('aria-activedescendant follows the arrow keys', () => {
    render(<Composer />);
    open();
    const menu = screen.getByRole('menu');
    const items = within(menu).getAllByRole('menuitemradio');
    expect(menu).toHaveAttribute('aria-activedescendant', items[0].id);
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(menu).toHaveAttribute('aria-activedescendant', items[1].id);
    fireEvent.keyDown(menu, { key: 'ArrowUp' });
    expect(menu).toHaveAttribute('aria-activedescendant', items[0].id);
  });

  it('returns focus to the trigger after Escape and after a selection', () => {
    render(<Composer />);
    const trigger = screen.getByRole('button', { name: 'Choose project' });
    open();
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    expect(trigger).toHaveFocus();
    open();
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'recent' }));
    expect(trigger).toHaveFocus();
  });

  it('sends the pill project, then the pill is gone', async () => {
    const send = vi.spyOn(api, 'endlessSend').mockResolvedValue({ ok: true });
    render(<Composer />);
    open();
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'recent' }));
    const box = screen.getByRole('textbox', { name: 'Message' });
    fireEvent.change(box, { target: { value: 'hi' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(send).toHaveBeenCalledWith('hi', 's2', []));
    await waitFor(() => expect(screen.queryByTestId('project-pill')).not.toBeInTheDocument());
  });

  it('a failed send keeps the pill and the text', async () => {
    vi.spyOn(api, 'endlessSend').mockRejectedValue(new Error('503'));
    render(<Composer />);
    open();
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'recent' }));
    const box = screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: 'hi' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(await screen.findByText(/503/)).toBeInTheDocument();
    expect(screen.getByTestId('project-pill')).toHaveTextContent('recent');
    expect(box.value).toBe('hi');
  });

  it('changing the filter does not set a pill', () => {
    render(<Composer />);
    act(() => { useEndless.setState({ filter: 's1' }); });
    expect(screen.queryByTestId('project-pill')).not.toBeInTheDocument();
  });
});

describe('ProjectsPanel refresh spinner', () => {
  it('is busy with a spinner while loadProjects is pending, idle after', async () => {
    let done!: () => void;
    vi.spyOn(api, 'endlessProjects').mockImplementation(() => new Promise((r) => { done = () => r([]); }));
    render(<ProjectsPanel />);
    const btn = screen.getByRole('button', { name: 'Refresh projects' });
    expect(btn).toHaveAttribute('aria-busy', 'false');
    fireEvent.click(btn);
    await waitFor(() => expect(btn).toHaveAttribute('aria-busy', 'true'));
    expect(btn).toBeDisabled();
    expect(btn.querySelector('.endless-spin')).not.toBeNull();
    done();
    await waitFor(() => expect(btn).toHaveAttribute('aria-busy', 'false'), { timeout: 2000 });
    expect(btn).not.toBeDisabled();
    expect(btn.querySelector('.endless-spin')).toBeNull();
  });
});
