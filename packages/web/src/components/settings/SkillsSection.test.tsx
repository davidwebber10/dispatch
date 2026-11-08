import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SkillsSection } from './SkillsSection';
import { api } from '../../api/client';
import { useProjects } from '../../stores/projects';
import type { SkillRow } from '../../api/types';
import { pickOption } from '../../test/select';

let skills: SkillRow[];
const skill = (id: string, extra: Partial<SkillRow> = {}): SkillRow => ({ id, name: `Skill ${id}`, version: '1.0.0', description: `${id} helps`, harnesses: null, folder: `/s/${id}`, install: null, enabled: true, enabledHere: true, text: `# ${id}\n\nDo ${id}.`, ...extra });

beforeEach(() => {
  skills = [skill('review'), skill('tidy', { install: { marketplace: 'u', version: '1.0.0', commit: 'c', installedAt: 't' } })];
  useProjects.setState({ sessions: [{ id: 's1', name: 'Alpha' }, { id: 's2', name: 'Beta' }] as any });
  vi.spyOn(api, 'listSkills').mockImplementation(async (project) => ({ skills: skills.map((s) => ({ ...s, enabledHere: s.enabled && !(project === 's2' && s.id === 'review') })) }));
  vi.spyOn(api, 'enableSkill').mockImplementation(async (id, project) => { const s = skills.find((x) => x.id === id)!; if (!project) s.enabled = true; return s; });
  vi.spyOn(api, 'disableSkill').mockImplementation(async (id, project) => { const s = skills.find((x) => x.id === id)!; if (!project) s.enabled = false; return s; });
  vi.spyOn(api, 'removeSkill').mockImplementation(async (id) => { skills = skills.filter((x) => x.id !== id); });
});
afterEach(() => { vi.restoreAllMocks(); });

const openRow = (id: string) => fireEvent.click(within(screen.getByTestId(`skill-row-${id}`)).getByRole('button', { name: new RegExp(`Skill ${id}`) }));

describe('Settings → Skills (plugins slice 6; list rows 2026-11-07)', () => {
  it('lists skills as one group of rows: a switch and the one-line description; the switch calls the API', async () => {
    render(<SkillsSection />);
    const review = await screen.findByTestId('skill-row-review');
    expect(review).toHaveTextContent('Skill review');
    expect(review).toHaveTextContent('review helps');
    // No per-card label or buttons: the row holds the switch, the rest is on the skill's page.
    expect(within(review).queryByText('Enabled everywhere')).toBeNull();
    expect(within(review).queryByRole('button', { name: 'Remove' })).toBeNull();
    expect(within(screen.getByRole('group', { name: 'Skills' })).getAllByTestId(/^skill-row-/)).toHaveLength(2);
    fireEvent.click(within(review).getByRole('switch', { name: 'Enabled everywhere' }));
    await waitFor(() => expect(api.disableSkill).toHaveBeenCalledWith('review'));
  });

  it('the project filter is a row at the top; with a project picked the row switch is that project\'s', async () => {
    render(<SkillsSection />);
    await screen.findByTestId('skill-row-review');
    pickOption('Project', 'Beta');
    await waitFor(() => expect(api.listSkills).toHaveBeenCalledWith('s2'));
    await waitFor(() => expect(within(screen.getByTestId('skill-row-review')).getByRole('switch', { name: 'Enabled for Beta' })).toHaveAttribute('aria-checked', 'false'));
    fireEvent.click(within(screen.getByTestId('skill-row-review')).getByRole('switch', { name: 'Enabled for Beta' }));
    await waitFor(() => expect(api.enableSkill).toHaveBeenCalledWith('review', 's2'));
  });

  it('a skill\'s page shows its source, its text and both switches, and removes it after a confirm', async () => {
    render(<SkillsSection />);
    await screen.findByTestId('skill-row-tidy');
    openRow('review');
    let page = screen.getByTestId('skill-page-review');
    expect(within(page).getByTestId('subpage-header')).toHaveTextContent('v1.0.0 · Local');
    expect(within(page).getByTestId('skill-text')).toHaveTextContent('Do review.');
    fireEvent.click(screen.getByRole('button', { name: 'Back to skills' }));
    openRow('tidy');
    page = screen.getByTestId('skill-page-tidy');
    expect(within(page).getByTestId('subpage-header')).toHaveTextContent('Installed');
    expect(within(page).getByRole('switch', { name: 'Enabled everywhere' })).toBeInTheDocument();
    fireEvent.click(within(page).getByRole('button', { name: 'Remove skill' }));
    expect(api.removeSkill).not.toHaveBeenCalled();
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Remove skill' }));
    await waitFor(() => expect(api.removeSkill).toHaveBeenCalledWith('tidy'));
    await waitFor(() => expect(screen.queryByTestId('skill-page-tidy')).toBeNull());
    expect(screen.queryByTestId('skill-row-tidy')).toBeNull();
    expect(screen.getByTestId('skill-row-review')).toBeInTheDocument();
  });

  it('with a project picked, the page has the project\'s switch too', async () => {
    render(<SkillsSection />);
    await screen.findByTestId('skill-row-review');
    pickOption('Project', 'Alpha');
    await waitFor(() => expect(api.listSkills).toHaveBeenCalledWith('s1'));
    openRow('review');
    const page = screen.getByTestId('skill-page-review');
    expect(within(page).getByRole('switch', { name: 'Enabled everywhere' })).toBeInTheDocument();
    fireEvent.click(within(page).getByRole('switch', { name: 'Enabled for Alpha' }));
    await waitFor(() => expect(api.disableSkill).toHaveBeenCalledWith('review', 's1'));
  });

  it('with no skills, says what to do instead of an empty card', async () => {
    skills = [];
    render(<SkillsSection />);
    expect(await screen.findByTestId('empty-state')).toHaveTextContent(/No skills yet/);
  });
});

describe('Settings → Skills on a phone (2026-11-07)', () => {
  const wide = window.innerWidth;
  afterEach(() => { Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: wide }); history.replaceState(null, ''); });

  it("opens a skill's page as a history entry, with no back link; back (popstate) returns to the list", async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 390 });
    history.replaceState({ nav: 1, settingsSection: 'skills', depth: 1 }, '');
    render(<SkillsSection />);
    await screen.findByTestId('skill-row-review');
    openRow('review');
    expect(screen.getByTestId('skill-page-review')).toBeInTheDocument();
    expect(history.state).toMatchObject({ settingsSection: 'skills', subPage: 'review', depth: 2 });
    expect(screen.queryByRole('button', { name: 'Back to skills' })).toBeNull();
    act(() => {
      history.replaceState({ nav: 1, settingsSection: 'skills', depth: 1 }, '');
      window.dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
    });
    expect(screen.queryByTestId('skill-page-review')).toBeNull();
    expect(screen.getByTestId('skill-row-review')).toBeInTheDocument();
  });
});
