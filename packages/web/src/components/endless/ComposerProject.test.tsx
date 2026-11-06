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

// The project choice lives in the composer's + menu (2026-11-05: Chat uses the Control Plane composer).
const open = () => {
  fireEvent.click(screen.getByRole('button', { name: 'More input options' }));
  fireEvent.click(screen.getByRole('button', { name: /^Project/ }));
};

describe('Composer project picker', () => {
  it('the + menu opens a Project list, most recent first, and picking one shows a pill', () => {
    render(<Composer />);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    open();
    const items = within(screen.getByRole('menu')).getAllByRole('menuitemradio');
    expect(items.map((i) => i.textContent)).toEqual(['No project✓', 'recent', 'salsify']); // none chosen yet
    fireEvent.click(items[2]);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(screen.getByTestId('project-pill')).toHaveTextContent('salsify');
    open();
    expect(screen.getByRole('menuitemradio', { name: 'salsify' })).toHaveAttribute('aria-checked', 'true');
  });

  it('the x removes the pill, and so does No project', () => {
    render(<Composer />);
    open();
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'recent' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove project' }));
    expect(screen.queryByTestId('project-pill')).not.toBeInTheDocument();
    open();
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'recent' }));
    open();
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'No project' }));
    expect(screen.queryByTestId('project-pill')).not.toBeInTheDocument();
  });

  it('an outside click closes the + menu', () => {
    render(<Composer />);
    open();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Project/ })).not.toBeInTheDocument();
  });

  it('sends the pill project, then the pill is gone', async () => {
    const send = vi.spyOn(api, 'endlessSend').mockResolvedValue({ ok: true });
    render(<Composer />);
    open();
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'recent' }));
    const box = screen.getByRole('textbox', { name: 'Message' });
    fireEvent.change(box, { target: { value: 'hi' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(send).toHaveBeenCalledWith('hi', 's2', [], []));
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
