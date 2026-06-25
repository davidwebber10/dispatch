import { render, screen, waitFor } from '@testing-library/react';
import { vi, test, expect } from 'vitest';

vi.mock('../common/Modal', () => ({ Modal: ({ title, children }: any) => <div>{title}{children}</div> }));
vi.mock('../../stores/tabs', () => ({ useTabs: { getState: () => ({ loadTabs: async () => {}, markLoading: () => {} }) } }));

const recentCcSessions = vi.fn();
vi.mock('../../api/client', () => ({ api: {
  recentCcSessions: (id: string) => recentCcSessions(id),
  createTerminal: vi.fn(),
} }));

import { NewClaudeThreadModal } from './NewClaudeThreadModal';

test('shows new-thread action + recent resume rows', async () => {
  recentCcSessions.mockResolvedValue([
    { id: 's1', mtime: Date.now() - 60000, preview: 'fix the build', messageCount: 12, truncated: false },
    { id: 's2', mtime: Date.now() - 3600000, preview: 'add dark mode', messageCount: 4, truncated: false },
  ]);
  render(<NewClaudeThreadModal sessionId="proj1" onClose={() => {}} onCreated={() => {}} />);
  expect(screen.getByText('Start new thread')).toBeInTheDocument();
  await waitFor(() => expect(screen.getByText('fix the build')).toBeInTheDocument());
  expect(screen.getByText('add dark mode')).toBeInTheDocument();
});

test('no resume section when there are no recent sessions', async () => {
  recentCcSessions.mockResolvedValue([]);
  render(<NewClaudeThreadModal sessionId="proj1" onClose={() => {}} onCreated={() => {}} />);
  await waitFor(() => expect(recentCcSessions).toHaveBeenCalled());
  expect(screen.queryByText('RESUME RECENT')).not.toBeInTheDocument();
  expect(screen.getByText('Start new thread')).toBeInTheDocument();
});
