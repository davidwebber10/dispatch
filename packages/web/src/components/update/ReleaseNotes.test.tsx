import { render, screen, fireEvent } from '@testing-library/react';
import { test, expect, vi } from 'vitest';
import { ReleaseNotes } from './ReleaseNotes';
import type { ReleaseNote } from '../../api/types';

const note = (version: string, body: string, publishedAt = '2026-08-01T00:00:00Z'): ReleaseNote =>
  ({ version, url: `https://example.com/${version}`, publishedAt, notes: body });

test('renders nothing when there is neither a pending note nor a current one', () => {
  const { container } = render(<ReleaseNotes notes={[]} currentNote={null} />);
  expect(container).toBeEmptyDOMElement();
});

test('starts collapsed — the body is hidden until you expand it', () => {
  render(<ReleaseNotes notes={[note('v2.11.0', '# Dispatch v2.11.0 — notes in the prompt\n\nThe change.')]} />);
  expect(screen.getByText('Release notes')).toBeInTheDocument();
  expect(screen.queryByText('The change.')).not.toBeInTheDocument();
});

test('expanding shows the version, the headline and the rendered body', () => {
  render(<ReleaseNotes notes={[note('v2.11.0', '# Dispatch v2.11.0 — notes in the prompt\n\nThe change.')]} />);
  fireEvent.click(screen.getByText('Release notes'));
  expect(screen.getByText('v2.11.0')).toBeInTheDocument();
  expect(screen.getByText('notes in the prompt')).toBeInTheDocument();
  expect(screen.getByText('The change.')).toBeInTheDocument();
});

test('collapsing hides it again', () => {
  render(<ReleaseNotes notes={[note('v2.11.0', 'Body text.')]} />);
  fireEvent.click(screen.getByText('Release notes'));
  fireEvent.click(screen.getByText('Release notes'));
  expect(screen.queryByText('Body text.')).not.toBeInTheDocument();
});

test('lists every skipped version, newest first, and says how many', () => {
  render(<ReleaseNotes notes={[note('v2.12.0', 'Third.'), note('v2.11.0', 'Second.')]} />);
  fireEvent.click(screen.getByText('Release notes (2 versions)'));
  const versions = screen.getAllByText(/^v2\.1[12]\.0$/).map((el) => el.textContent);
  expect(versions).toEqual(['v2.12.0', 'v2.11.0']);
});

test('the panel scrolls rather than growing without bound', () => {
  render(<ReleaseNotes notes={[note('v2.11.0', 'Body.')]} />);
  fireEvent.click(screen.getByText('Release notes'));
  const panel = screen.getByText('Body.').closest('div[style*="overflow-y"]') as HTMLElement;
  expect(panel).toBeTruthy();
  expect(panel.style.maxHeight).toBe('min(45vh, 320px)');
});

test('falls back to the running version\'s note when no update is pending', () => {
  render(<ReleaseNotes notes={[]} currentNote={'# Dispatch v2.10.0 — sidebar limits\n\nWhat shipped.'} currentVersion="2.10.0" />);
  const row = screen.getByText("What's new in v2.10.0");
  fireEvent.click(row);
  expect(screen.getByText('sidebar limits')).toBeInTheDocument();
  expect(screen.getByText('What shipped.')).toBeInTheDocument();
});

test('a pending update wins over the current-version note', () => {
  render(<ReleaseNotes notes={[note('v2.11.0', 'Pending.')]} currentNote="Current." currentVersion="2.10.0" />);
  expect(screen.getByText('Release notes')).toBeInTheDocument();
  expect(screen.queryByText(/What's new/)).not.toBeInTheDocument();
});

test('reports expand and collapse to the host so the modal can widen', () => {
  const onToggle = vi.fn();
  render(<ReleaseNotes notes={[note('v2.11.0', 'Body.')]} onToggle={onToggle} />);
  fireEvent.click(screen.getByText('Release notes'));
  fireEvent.click(screen.getByText('Release notes'));
  expect(onToggle.mock.calls.map((c) => c[0])).toEqual([true, false]);
});

test('shows a placeholder rather than an empty panel when a release has no body', () => {
  render(<ReleaseNotes notes={[note('v2.11.0', '')]} />);
  fireEvent.click(screen.getByText('Release notes'));
  expect(screen.getByText('No notes for this release.')).toBeInTheDocument();
});

test('omits an unparseable published date instead of printing "Invalid Date"', () => {
  render(<ReleaseNotes notes={[note('v2.11.0', 'Body.', 'not-a-date')]} />);
  fireEvent.click(screen.getByText('Release notes'));
  expect(screen.queryByText(/Invalid Date/)).not.toBeInTheDocument();
});
