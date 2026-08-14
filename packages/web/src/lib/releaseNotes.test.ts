import { describe, expect, test } from 'vitest';
import { splitNoteHeadline } from './releaseNotes';

describe('splitNoteHeadline', () => {
  test('lifts the H1 out of the body', () => {
    const out = splitNoteHeadline('# Something happened\n\nThe change.\n');
    expect(out.headline).toBe('Something happened');
    expect(out.body).toBe('The change.');
  });

  test('drops the redundant "Dispatch vX.Y.Z —" prefix from the headline', () => {
    const out = splitNoteHeadline('# Dispatch v2.9.0 — coordinator session controls\n\nBody.');
    expect(out.headline).toBe('coordinator session controls');
  });

  test('handles a plain hyphen and an en dash as the separator', () => {
    expect(splitNoteHeadline('# Dispatch v2.9.0 - thing').headline).toBe('thing');
    expect(splitNoteHeadline('# Dispatch 2.9.0 – thing').headline).toBe('thing');
  });

  test('skips blank lines before the H1', () => {
    expect(splitNoteHeadline('\n\n# Title\n\nBody.').headline).toBe('Title');
  });

  test('returns the whole text as body when there is no H1', () => {
    const out = splitNoteHeadline('## Only a subheading\n\nBody.');
    expect(out.headline).toBeNull();
    expect(out.body).toBe('## Only a subheading\n\nBody.');
  });

  test('does not treat an H2 or a hashtag mid-line as the headline', () => {
    expect(splitNoteHeadline('## Nope').headline).toBeNull();
    expect(splitNoteHeadline('see #123 for detail').headline).toBeNull();
  });

  test('returns a null headline when the H1 is only the version', () => {
    const out = splitNoteHeadline('# Dispatch v2.9.0\n\nBody.');
    expect(out.headline).toBeNull();
    expect(out.body).toBe('Body.');
  });

  test('survives an empty note', () => {
    expect(splitNoteHeadline('')).toEqual({ headline: null, body: '' });
  });
});
