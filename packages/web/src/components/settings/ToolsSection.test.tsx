import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { vi, test, expect, afterEach } from 'vitest';
import { ToolsSection } from './ToolsSection';
import { api } from '../../api/client';

afterEach(() => vi.restoreAllMocks());

const TOOLS = { tools: [
  { name: 'jq', description: 'JSON processor', kind: 'binary' as const, installed: true, authed: true },
  { name: 'gh', description: 'GitHub CLI', kind: 'binary' as const, installed: true, authed: false },
  { name: 'aws', description: 'AWS CLI', kind: 'script' as const, installed: false, authed: false },
] };

test('lists tools with installed + auth badges', async () => {
  vi.spyOn(api, 'getTools').mockResolvedValue(TOOLS);
  render(<ToolsSection />);
  await waitFor(() => expect(screen.getByText('jq')).toBeInTheDocument());
  expect(screen.getByText('GitHub CLI')).toBeInTheDocument();
  expect(screen.getByText('AWS CLI')).toBeInTheDocument();
  // gh is installed but not authed → shows a "needs auth" affordance (≥1 match expected)
  expect(screen.getAllByText(/needs auth/i).length).toBeGreaterThan(0);
});

test('groups tools by status: ready / needs auth / missing', async () => {
  vi.spyOn(api, 'getTools').mockResolvedValue(TOOLS);
  render(<ToolsSection />);
  await waitFor(() => expect(screen.getByText('jq')).toBeInTheDocument());
  expect(screen.getByText('READY')).toBeInTheDocument();
  expect(screen.getByText('NEEDS AUTH')).toBeInTheDocument();
  expect(screen.getByText('MISSING')).toBeInTheDocument();
  expect(screen.getByText('installed · authed')).toBeInTheDocument();
  expect(screen.getByText('not installed')).toBeInTheDocument();
  expect(screen.getByText(/3 tools · 1 need auth/)).toBeInTheDocument();
});

test('segmented filter narrows to one status group', async () => {
  vi.spyOn(api, 'getTools').mockResolvedValue(TOOLS);
  render(<ToolsSection />);
  await waitFor(() => expect(screen.getByText('jq')).toBeInTheDocument());
  fireEvent.click(screen.getByRole('button', { name: /Ready 1/ }));
  expect(screen.getByText('jq')).toBeInTheDocument();
  expect(screen.queryByText('gh')).not.toBeInTheDocument();
  expect(screen.queryByText('aws')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /Needs auth 1/ }));
  expect(screen.getByText('gh')).toBeInTheDocument();
  expect(screen.queryByText('jq')).not.toBeInTheDocument();
});
