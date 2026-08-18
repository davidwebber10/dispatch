import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { MAX_NOTE_CHARS, MAX_NOTES, collectPendingNotes, parseStoredNotes, readLocalReleaseNote } from './notes.js';

let root: string;

function writeNote(tag: string, body: string): void {
  fs.mkdirSync(path.join(root, 'docs', 'releases'), { recursive: true });
  fs.writeFileSync(path.join(root, 'docs', 'releases', `${tag}.md`), body);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-notes-'));
});
afterEach(() => {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
});

describe('readLocalReleaseNote', () => {
  it('reads docs/releases/vX.Y.Z.md for a bare version', () => {
    writeNote('v2.10.0', '# Dispatch v2.10.0\n\nThe change.\n');
    expect(readLocalReleaseNote('2.10.0', root)).toBe('# Dispatch v2.10.0\n\nThe change.');
  });

  it('accepts a version that already carries the v prefix', () => {
    writeNote('v2.10.0', 'body');
    expect(readLocalReleaseNote('v2.10.0', root)).toBe('body');
  });

  it('returns null when no note exists for that version', () => {
    expect(readLocalReleaseNote('9.9.9', root)).toBeNull();
  });

  it('returns null for an empty or whitespace-only note', () => {
    writeNote('v2.10.0', '   \n\n');
    expect(readLocalReleaseNote('2.10.0', root)).toBeNull();
  });

  it('refuses a version string that is not a plain semver (no path traversal)', () => {
    writeNote('v2.10.0', 'body');
    expect(readLocalReleaseNote('../../../etc/passwd', root)).toBeNull();
    expect(readLocalReleaseNote('2.10.0/../../secret', root)).toBeNull();
  });
});

describe('collectPendingNotes', () => {
  const rel = (tag: string, body = `notes for ${tag}`) => ({
    tag_name: tag,
    html_url: `https://example.com/${tag}`,
    published_at: '2026-01-01T00:00:00Z',
    body,
    draft: false,
    prerelease: false,
  });

  it('keeps only releases newer than the running version, newest first', () => {
    const out = collectPendingNotes([rel('v2.9.0'), rel('v2.11.0'), rel('v2.10.0'), rel('v2.12.0')], '2.10.0');
    expect(out.map((n) => n.version)).toEqual(['v2.12.0', 'v2.11.0']);
  });

  it('carries the body, url and published date through', () => {
    const [note] = collectPendingNotes([rel('v2.11.0', '## What changed')], '2.10.0');
    expect(note).toEqual({
      version: 'v2.11.0',
      url: 'https://example.com/v2.11.0',
      publishedAt: '2026-01-01T00:00:00Z',
      notes: '## What changed',
    });
  });

  it('drops drafts and prereleases', () => {
    const draft = { ...rel('v2.13.0'), draft: true };
    const pre = { ...rel('v2.12.0'), prerelease: true };
    const out = collectPendingNotes([draft, pre, rel('v2.11.0')], '2.10.0');
    expect(out.map((n) => n.version)).toEqual(['v2.11.0']);
  });

  it('drops entries with no tag', () => {
    expect(collectPendingNotes([{ ...rel('v2.11.0'), tag_name: '' }], '2.10.0')).toEqual([]);
  });

  it(`caps the list at ${MAX_NOTES} releases, keeping the newest`, () => {
    const many = Array.from({ length: MAX_NOTES + 5 }, (_, i) => rel(`v3.0.${i + 1}`));
    const out = collectPendingNotes(many, '3.0.0');
    expect(out).toHaveLength(MAX_NOTES);
    expect(out[0].version).toBe(`v3.0.${MAX_NOTES + 5}`);
  });

  it('truncates an oversized body so app_state cannot balloon', () => {
    const [note] = collectPendingNotes([rel('v2.11.0', 'x'.repeat(MAX_NOTE_CHARS + 500))], '2.10.0');
    expect(note.notes.length).toBeLessThanOrEqual(MAX_NOTE_CHARS + 40);
    expect(note.notes).toMatch(/truncated/i);
  });

  it('normalises a missing body to an empty string rather than undefined', () => {
    const [note] = collectPendingNotes([{ ...rel('v2.11.0'), body: null } as never], '2.10.0');
    expect(note.notes).toBe('');
  });
});

describe('parseStoredNotes', () => {
  const stored = JSON.stringify([
    { version: 'v2.12.0', url: 'u', publishedAt: 'p', notes: 'n12' },
    { version: 'v2.11.0', url: 'u', publishedAt: 'p', notes: 'n11' },
  ]);

  it('returns the notes still newer than the running version', () => {
    expect(parseStoredNotes(stored, '2.11.0').map((n) => n.version)).toEqual(['v2.12.0']);
  });

  it('returns an empty list once the daemon runs the newest version', () => {
    expect(parseStoredNotes(stored, '2.12.0')).toEqual([]);
  });

  it('survives null, malformed JSON and a non-array payload', () => {
    expect(parseStoredNotes(null, '1.0.0')).toEqual([]);
    expect(parseStoredNotes('{not json', '1.0.0')).toEqual([]);
    expect(parseStoredNotes('{"version":"v9.9.9"}', '1.0.0')).toEqual([]);
  });

  it('drops malformed entries inside an otherwise valid array', () => {
    const mixed = JSON.stringify([{ notes: 'orphan' }, { version: 'v2.11.0', url: 'u', publishedAt: 'p', notes: 'ok' }]);
    expect(parseStoredNotes(mixed, '2.10.0').map((n) => n.notes)).toEqual(['ok']);
  });
});
