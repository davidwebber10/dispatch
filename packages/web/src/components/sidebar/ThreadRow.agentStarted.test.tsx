import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render } from '@testing-library/react';
import { ProjectCard } from './ProjectCard';
import { useTabs } from '../../stores/tabs';
import { api } from '../../api/client';
import type { Session, Terminal } from '../../api/types';

const session: Session = {
  id: 's1', provider: 'claude-code', name: 'proj', notes: '', status: 'waiting',
  workingDir: '/tmp/proj', tags: [], pid: null, createdAt: '2026-07-14T00:00:00.000Z',
  updatedAt: '2026-07-14T00:00:00.000Z', lastActivityAt: '2026-07-14T00:00:00.000Z', archivedAt: null,
};

const thread = (id: string, config: Record<string, unknown>): Terminal => ({
  id, sessionId: 's1', type: 'claude-code', label: id, pid: null, externalId: null, workingDir: null,
  status: 'waiting', createdAt: '2026-07-14T11:00:00.000Z', lastActivityAt: '2026-07-14T11:00:00.000Z', config, archivedAt: null, sortOrder: 0,
});

const marked = (id: string) => !!document.querySelector(`[data-thread-id="${id}"] [data-agent-started]`);

beforeEach(() => { vi.spyOn(api, 'listTerminals').mockResolvedValue([]); });
afterEach(() => { vi.restoreAllMocks(); });

describe('ThreadRow agent-started mark', () => {
  it('marks threads that Chat, an overseer, a thread or a role started, and leaves the owner\'s threads plain', () => {
    useTabs.setState({
      byProject: {
        s1: [
          thread('mine', { transport: 'structured' }),
          thread('chat', { transport: 'structured', origin: 'endless' }),
          thread('worker', { role: 'agent', spawnedBy: 'mine' }),
          thread('role', { roleRun: 'reviewer' }),
        ],
      },
      loading: {},
    } as any);

    render(<ProjectCard session={session} active open onSelectTab={() => {}} />);
    expect(marked('mine')).toBe(false);
    expect(marked('chat')).toBe(true);
    expect(marked('worker')).toBe(true);
    expect(marked('role')).toBe(true);
    expect(document.querySelector('[data-thread-id="chat"] [title="Started by an agent, not by you"]')).not.toBeNull();
    // Option D (owner, 2026-11-27): the type glyph stays and a small badge sits on its corner.
    const badge = (id: string) => document.querySelector(`[data-thread-id="${id}"] [data-agent-badge]`);
    expect(badge('mine')).toBeNull();
    expect(badge('chat')).not.toBeNull();
    expect(badge('chat')!.getAttribute('aria-label')).toBe('Started by an agent');
    // Two glyphs on an agent row (type + badge), one on the owner's row.
    const glyphs = (id: string) => document.querySelectorAll(`[data-thread-id="${id}"] [data-agent-started] svg, [data-thread-id="${id}"] span:first-child > svg`).length;
    expect(document.querySelectorAll('[data-thread-id="chat"] [data-agent-started] svg').length).toBe(2);
    expect(glyphs('mine')).toBe(1);
  });
});
