import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
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

describe('Settings → Skills (plugins slice 6)', () => {
  it('lists skills with their source; the global switch and a per-project switch call the API; Remove drops one', async () => {
    render(<SkillsSection />);
    const review = await screen.findByTestId('skill-row-review');
    expect(review).toHaveTextContent('Skill review');
    expect(review).toHaveTextContent('Local');
    expect(screen.getByTestId('skill-row-tidy')).toHaveTextContent('Installed');
    fireEvent.click(within(review).getByRole('switch', { name: 'Enabled everywhere' }));
    await waitFor(() => expect(api.disableSkill).toHaveBeenCalledWith('review'));
    pickOption('Project', 'Beta');
    await waitFor(() => expect(api.listSkills).toHaveBeenCalledWith('s2'));
    const reviewB = await screen.findByTestId('skill-row-review');
    const here = within(reviewB).getByRole('switch', { name: 'Enabled for Beta' });
    expect(here).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(here);
    await waitFor(() => expect(api.enableSkill).toHaveBeenCalledWith('review', 's2'));
    fireEvent.click(within(screen.getByTestId('skill-row-tidy')).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(api.removeSkill).toHaveBeenCalledWith('tidy'));
    await waitFor(() => expect(screen.queryByTestId('skill-row-tidy')).toBeNull());
  });
});
