import { render, screen, waitFor } from '@testing-library/react';
import { vi, test, expect, afterEach } from 'vitest';
import { ToolsSection } from './ToolsSection';
import { api } from '../../api/client';

afterEach(() => vi.restoreAllMocks());

test('lists tools with installed + auth badges', async () => {
  vi.spyOn(api, 'getTools').mockResolvedValue({ tools: [
    { name: 'jq', description: 'JSON processor', kind: 'binary', installed: true, authed: true },
    { name: 'gh', description: 'GitHub CLI', kind: 'binary', installed: true, authed: false },
    { name: 'aws', description: 'AWS CLI', kind: 'script', installed: false, authed: false },
  ] });
  render(<ToolsSection />);
  await waitFor(() => expect(screen.getByText('jq')).toBeInTheDocument());
  expect(screen.getByText('GitHub CLI')).toBeInTheDocument();
  expect(screen.getByText('AWS CLI')).toBeInTheDocument();
  // gh is installed but not authed → shows a "needs auth" affordance (≥1 match expected)
  expect(screen.getAllByText(/needs auth/i).length).toBeGreaterThan(0);
});
