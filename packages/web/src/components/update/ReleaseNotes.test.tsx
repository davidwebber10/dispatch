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

test('expanding shows the version and a single line of what changed — not the essay', () => {
  render(<ReleaseNotes notes={[note('v2.11.0', '# Dispatch v2.11.0 — notes in the prompt\n\n## What was wrong\n\nThe change.')]} />);
  fireEvent.click(screen.getByText('Release notes'));
  expect(screen.getByText('v2.11.0')).toBeInTheDocument();
  expect(screen.getByText('notes in the prompt')).toBeInTheDocument();
  // The body stays folded away: the whole point is that this is scannable.
  expect(screen.queryByText('The change.')).not.toBeInTheDocument();
  expect(screen.queryByText('What was wrong')).not.toBeInTheDocument();
});

test('the full note is one tap away, not gone', () => {
  render(<ReleaseNotes notes={[note('v2.11.0', '# Dispatch v2.11.0 — headline\n\n## What was wrong\n\nThe change.')]} />);
  fireEvent.click(screen.getByText('Release notes'));
  fireEvent.click(screen.getByText('Full notes'));
  expect(screen.getByText('The change.')).toBeInTheDocument();
  fireEvent.click(screen.getByText('Hide detail'));
  expect(screen.queryByText('The change.')).not.toBeInTheDocument();
});

test('several versions read as one line each', () => {
  render(<ReleaseNotes notes={[
    note('v2.12.0', '# Dispatch v2.12.0 — third thing\n\nBody three.'),
    note('v2.11.0', '# Dispatch v2.11.0 — second thing\n\nBody two.'),
  ]} />);
  fireEvent.click(screen.getByText('Release notes (2 versions)'));
  expect(screen.getByText('third thing')).toBeInTheDocument();
  expect(screen.getByText('second thing')).toBeInTheDocument();
  expect(screen.queryByText('Body three.')).not.toBeInTheDocument();
  expect(screen.queryByText('Body two.')).not.toBeInTheDocument();
  // One "Full notes" affordance per release, not one for the panel.
  expect(screen.getAllByText('Full notes')).toHaveLength(2);
});

test('a release with only a headline offers no empty detail toggle', () => {
  render(<ReleaseNotes notes={[note('v2.11.0', '# Dispatch v2.11.0 — just a headline')]} />);
  fireEvent.click(screen.getByText('Release notes'));
  expect(screen.getByText('just a headline')).toBeInTheDocument();
  expect(screen.queryByText('Full notes')).not.toBeInTheDocument();
});

test('collapsing hides it again', () => {
  render(<ReleaseNotes notes={[note('v2.11.0', 'Body text.')]} />);
  fireEvent.click(screen.getByText('Release notes'));
  expect(screen.getByText('Full notes')).toBeInTheDocument();
  fireEvent.click(screen.getByText('Release notes'));
  expect(screen.queryByText('Full notes')).not.toBeInTheDocument();
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
  fireEvent.click(screen.getByText('Full notes'));
  const panel = screen.getByText('Body.').closest('div[style*="overflow-y"]') as HTMLElement;
  expect(panel).toBeTruthy();
  expect(panel.style.maxHeight).toBe('min(45vh, 320px)');
});

test('falls back to the running version\'s note when no update is pending', () => {
  render(<ReleaseNotes notes={[]} currentNote={'# Dispatch v2.10.0 — sidebar limits\n\nWhat shipped.'} currentVersion="2.10.0" />);
  fireEvent.click(screen.getByText("What's new in v2.10.0"));
  expect(screen.getByText('sidebar limits')).toBeInTheDocument();
  fireEvent.click(screen.getByText('Full notes'));
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

test('shows a placeholder rather than an empty panel when a release has no note at all', () => {
  render(<ReleaseNotes notes={[note('v2.11.0', '')]} />);
  fireEvent.click(screen.getByText('Release notes'));
  expect(screen.getByText('No notes for this release.')).toBeInTheDocument();
});

test('omits an unparseable published date instead of printing "Invalid Date"', () => {
  render(<ReleaseNotes notes={[note('v2.11.0', 'Body.', 'not-a-date')]} />);
  fireEvent.click(screen.getByText('Release notes'));
  expect(screen.queryByText(/Invalid Date/)).not.toBeInTheDocument();
});
