import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { vi, test, expect, afterEach } from 'vitest';
import { ToolsSection } from './ToolsSection';
import { api } from '../../api/client';
import type { ToolStatus } from '../../api/types';

afterEach(() => vi.restoreAllMocks());

const TOOLS = { tools: [
  { name: 'jq', description: 'JSON processor', kind: 'binary' as const, installed: true, authed: true, docs: 'https://jqlang.org' },
  { name: 'gh', description: 'GitHub CLI', kind: 'binary' as const, installed: true, authed: false, docs: 'https://cli.github.com' },
  { name: 'aws', description: 'AWS CLI', kind: 'script' as const, installed: false, authed: false },
], checkedAt: null as string | null };

const names = () => screen.getAllByTestId('tool-row').map((r) => r.getAttribute('data-tool'));

test('one "Tools" group: a row per tool with its name, one-line description and a status mark', async () => {
  vi.spyOn(api, 'getTools').mockResolvedValue(TOOLS);
  render(<ToolsSection />);
  await waitFor(() => expect(screen.getByText('jq')).toBeInTheDocument());
  const group = screen.getByRole('group', { name: 'Tools' });
  expect(within(group).getAllByTestId('tool-row')).toHaveLength(3);
  expect(screen.getByText('GitHub CLI')).toBeInTheDocument();
  expect(screen.getByText('AWS CLI')).toBeInTheDocument();
  const marks = screen.getAllByTestId('status-mark').map((m) => m.textContent);
  expect(marks).toEqual(['Sign in needed', 'Installed', 'Missing']);
  // No kind chips, no old mono status words, no old group headers.
  expect(screen.queryByText('binary')).not.toBeInTheDocument();
  expect(screen.queryByText('not installed')).not.toBeInTheDocument();
  expect(screen.queryByText('READY')).not.toBeInTheDocument();
});

test('rows that need a look come first: sign in needed, could not check, installed, missing', async () => {
  vi.spyOn(api, 'getTools').mockResolvedValue({ tools: [
    { name: 'a-missing', description: 'A', kind: 'binary', installed: false, authed: false },
    { name: 'b-ready', description: 'B', kind: 'binary', installed: true, authed: true },
    { name: 'c-unknown', description: 'C', kind: 'binary', installed: true, authed: false, authState: 'unknown' },
    { name: 'd-needed', description: 'D', kind: 'npm', installed: true, authed: false, authState: 'needed' },
  ], checkedAt: null });
  render(<ToolsSection />);
  await waitFor(() => expect(screen.getByText('a-missing')).toBeInTheDocument());
  expect(names()).toEqual(['d-needed', 'c-unknown', 'b-ready', 'a-missing']);
});

test('shows when the sign-in checks last ran, and "Check again" (the group action) re-runs them', async () => {
  const threeMinAgo = new Date(Date.now() - 3 * 60_000).toISOString();
  const signedIn = { tools: TOOLS.tools.map((t) => (t.name === 'gh' ? { ...t, authed: true } : t)), checkedAt: new Date().toISOString() };
  const spy = vi.spyOn(api, 'getTools')
    .mockResolvedValueOnce({ ...TOOLS, checkedAt: threeMinAgo })
    .mockResolvedValueOnce(signedIn);
  render(<ToolsSection />);
  await waitFor(() => expect(screen.getByText(/Checked 3m ago/)).toBeInTheDocument());
  expect(spy).toHaveBeenNthCalledWith(1); // the page load serves the cache
  expect(screen.getByText('Sign in needed')).toBeInTheDocument();
  fireEvent.click(within(screen.getByRole('group', { name: 'Tools' })).getByRole('button', { name: 'Check again' }));
  await waitFor(() => expect(screen.getByText(/Checked just now/)).toBeInTheDocument());
  expect(spy).toHaveBeenNthCalledWith(2, { refresh: true });
  expect(screen.queryByText('Sign in needed')).not.toBeInTheDocument(); // gh is ready now
});

test('"Check again" is disabled while a check runs', async () => {
  let release!: (v: typeof TOOLS) => void;
  vi.spyOn(api, 'getTools')
    .mockResolvedValueOnce(TOOLS)
    .mockImplementationOnce(() => new Promise((r) => { release = r; }));
  render(<ToolsSection />);
  await waitFor(() => expect(screen.getByText(/Not checked yet/)).toBeInTheDocument());
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

test('a sign-in that could not be checked is a neutral "Couldn\'t check"; a needed sign-in is a yellow mark', async () => {
  vi.spyOn(api, 'getTools').mockResolvedValue({ tools: [
    { name: 'gh', description: 'GitHub CLI', kind: 'binary', installed: true, authed: false, authState: 'needed' },
    { name: 'aws', description: 'AWS CLI', kind: 'script', installed: true, authed: false, authState: 'unknown' },
  ], checkedAt: null });
  render(<ToolsSection />);
  await waitFor(() => expect(screen.getByText('aws')).toBeInTheDocument());
  expect(screen.getByText('Sign in needed').closest('[data-testid="status-mark"]')!.getAttribute('style')).toContain('status-yellow');
  expect(screen.getByText("Couldn't check").closest('[data-testid="status-mark"]')!.getAttribute('style')).not.toMatch(/status-(red|yellow)/);
  // The footer says how many need a sign-in.
  expect(screen.getByText(/1 tool needs a sign-in/)).toBeInTheDocument();
});

test('without authState (an older daemon), authed alone decides', async () => {
  vi.spyOn(api, 'getTools').mockResolvedValue(TOOLS);
  render(<ToolsSection />);
  await waitFor(() => expect(screen.getByText('gh')).toBeInTheDocument());
  expect(screen.getByText('Sign in needed')).toBeInTheDocument();
  expect(screen.queryByText("Couldn't check")).not.toBeInTheDocument();
});

test('the docs link is a quiet icon action on the row, named for the tool', async () => {
  vi.spyOn(api, 'getTools').mockResolvedValue(TOOLS);
  render(<ToolsSection />);
  await waitFor(() => expect(screen.getByText('gh')).toBeInTheDocument());
  const link = screen.getByRole('link', { name: 'gh docs' });
  expect(link).toHaveAttribute('href', 'https://cli.github.com');
  expect(link).toHaveAttribute('target', '_blank');
  expect(screen.queryByRole('link', { name: 'aws docs' })).not.toBeInTheDocument(); // no docs URL, no link
  expect(screen.queryByText('docs')).not.toBeInTheDocument();
});

test('a long list gets a filter row that narrows by name or description', async () => {
  const many: ToolStatus[] = Array.from({ length: 10 }, (_, i) => ({ name: `tool${i}`, description: i === 7 ? 'Cloud storage' : `Tool number ${i}`, kind: 'binary', installed: true, authed: true }));
  vi.spyOn(api, 'getTools').mockResolvedValue({ tools: many, checkedAt: null });
  render(<ToolsSection />);
  await waitFor(() => expect(screen.getByText('tool0')).toBeInTheDocument());
  fireEvent.change(screen.getByRole('textbox', { name: 'Filter tools' }), { target: { value: 'cloud' } });
  expect(names()).toEqual(['tool7']);
  fireEvent.change(screen.getByRole('textbox', { name: 'Filter tools' }), { target: { value: 'zzz' } });
  expect(screen.getByText(/No tools match/)).toBeInTheDocument();
});

test('a short list has no filter', async () => {
  vi.spyOn(api, 'getTools').mockResolvedValue(TOOLS);
  render(<ToolsSection />);
  await waitFor(() => expect(screen.getByText('jq')).toBeInTheDocument());
  expect(screen.queryByRole('textbox', { name: 'Filter tools' })).not.toBeInTheDocument();
});

test('the intro names where to add your own tools, as code', async () => {
  vi.spyOn(api, 'getTools').mockResolvedValue(TOOLS);
  render(<ToolsSection />);
  await waitFor(() => expect(screen.getByText('jq')).toBeInTheDocument());
  expect(within(screen.getByTestId('settings-intro')).getByText('~/.dispatch/tools.json').tagName).toBe('CODE');
  expect(within(screen.getByTestId('settings-intro')).getByText('dispatch tools install').tagName).toBe('CODE');
});
