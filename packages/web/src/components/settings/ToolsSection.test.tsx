import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { vi, test, expect, afterEach } from 'vitest';
import { ToolsSection } from './ToolsSection';
import { api } from '../../api/client';

afterEach(() => vi.restoreAllMocks());

const TOOLS = { tools: [
  { name: 'jq', description: 'JSON processor', kind: 'binary' as const, installed: true, authed: true },
  { name: 'gh', description: 'GitHub CLI', kind: 'binary' as const, installed: true, authed: false },
  { name: 'aws', description: 'AWS CLI', kind: 'script' as const, installed: false, authed: false },
], checkedAt: null as string | null };

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

test('shows when the auth checks last ran, and "Check again" re-runs them', async () => {
  const threeMinAgo = new Date(Date.now() - 3 * 60_000).toISOString();
  const signedIn = { tools: TOOLS.tools.map((t) => (t.name === 'gh' ? { ...t, authed: true } : t)), checkedAt: new Date().toISOString() };
  const spy = vi.spyOn(api, 'getTools')
    .mockResolvedValueOnce({ ...TOOLS, checkedAt: threeMinAgo })
    .mockResolvedValueOnce(signedIn);
  render(<ToolsSection />);
  await waitFor(() => expect(screen.getByText('checked 3m ago')).toBeInTheDocument());
  expect(spy).toHaveBeenNthCalledWith(1); // the page load serves the cache
  expect(screen.getByText('NEEDS AUTH')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
  await waitFor(() => expect(screen.getByText('checked just now')).toBeInTheDocument());
  expect(spy).toHaveBeenNthCalledWith(2, { refresh: true });
  expect(screen.queryByText('NEEDS AUTH')).not.toBeInTheDocument(); // gh is ready now
});

test('"Check again" is disabled while a check runs', async () => {
  let release!: (v: typeof TOOLS) => void;
  vi.spyOn(api, 'getTools')
    .mockResolvedValueOnce(TOOLS)
    .mockImplementationOnce(() => new Promise((r) => { release = r; }));
  render(<ToolsSection />);
  await waitFor(() => expect(screen.getByText('not checked yet')).toBeInTheDocument());
  fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
  expect(screen.getByRole('button', { name: 'Checking…' })).toBeDisabled();
  release({ ...TOOLS, checkedAt: new Date().toISOString() });
  await waitFor(() => expect(screen.getByRole('button', { name: 'Check again' })).toBeEnabled());
});

test('a failed re-check says so and keeps the last list', async () => {
  vi.spyOn(api, 'getTools')
    .mockResolvedValueOnce(TOOLS)
    .mockRejectedValueOnce(new Error('GET /api/tools failed: 500'));
  render(<ToolsSection />);
  await waitFor(() => expect(screen.getByText('jq')).toBeInTheDocument());
  fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
  await waitFor(() => expect(screen.getByText('Could not reach Dispatch.')).toBeInTheDocument());
  expect(screen.getByText('jq')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Check again' })).toBeEnabled();
});

test('a sign-in that could not be checked is a neutral "couldn\'t check", not "needs auth"', async () => {
  vi.spyOn(api, 'getTools').mockResolvedValue({ tools: [
    { name: 'gh', description: 'GitHub CLI', kind: 'binary', installed: true, authed: false, authState: 'needed' },
    { name: 'aws', description: 'AWS CLI', kind: 'script', installed: true, authed: false, authState: 'unknown' },
  ], checkedAt: null });
  render(<ToolsSection />);
  await waitFor(() => expect(screen.getByText('aws')).toBeInTheDocument());
  expect(screen.getByText("COULDN'T CHECK")).toBeInTheDocument();
  expect(screen.getByText('needs auth').getAttribute('style')).toContain('status-red'); // red is detectable here
  expect(screen.getByText("couldn't check").getAttribute('style')).not.toContain('status-red');
  expect(screen.getByText(/2 tools · 1 need auth/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /Needs auth 1/ }));
  expect(screen.getByText('gh')).toBeInTheDocument();
  expect(screen.queryByText('aws')).not.toBeInTheDocument();
});

test('without authState (an older daemon), authed alone decides', async () => {
  vi.spyOn(api, 'getTools').mockResolvedValue(TOOLS);
  render(<ToolsSection />);
  await waitFor(() => expect(screen.getByText('gh')).toBeInTheDocument());
  expect(screen.getByText('needs auth')).toBeInTheDocument();
  expect(screen.queryByText("couldn't check")).not.toBeInTheDocument();
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
