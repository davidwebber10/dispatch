// The source file of a ledger item (titles and source panel spec 2026-10-09, Unit 7): the path and
// the section it stores, and the file read under the project folder only. Every test works in its
// own nested temporary folder: <tmp>/source-file-XXXX/{project,outside}.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { LedgerItem } from '../../src/db/ledger.js';
import { readSourceFile, SOURCE_MAX_BYTES, sourceFileRef, FOLDER_REASON, NOT_MARKDOWN_REASON, TOO_LARGE_REASON } from '../../src/overseer/source-file.js';

function item(over: Partial<LedgerItem>): LedgerItem {
  return {
    id: 1, sessionId: 's1', seq: 1, kind: 'decide', text: 'Which store goes first?', author: 'overseer',
    recommendation: null, options: null, blocks: null, mission: null, status: 'open',
    quote: null, quoteMessageId: null, quoteAt: null, reading: null, reason: null, supersedes: null,
    origin: 'live', createdAt: '2026-10-09T10:00:00.000Z', updatedAt: '2026-10-09T10:00:00.000Z',
    context: null, recommendationWhy: null, defaultText: null, sourceKind: null, sourceRef: null,
    sourceSection: null, sourceId: null, overseerNote: null, onDefaultSince: null, agentTerminalId: null,
    agentDecisionId: null, decidedChoice: null, decidedAt: null, policy: false, sentAt: null, title: null,
    ...over,
  };
}

describe('sourceFileRef — where an item\'s file is', () => {
  it('a plan or doc source: its ref and section', () => {
    expect(sourceFileRef(item({ sourceKind: 'plan', sourceRef: 'docs/plans/a.md', sourceSection: 'Risks' }))).toEqual({ path: 'docs/plans/a.md', section: 'Risks' });
    expect(sourceFileRef(item({ sourceKind: 'doc', sourceRef: 'docs/notes.md' }))).toEqual({ path: 'docs/notes.md', section: null });
  });

  it('an agent-block source: the path part of "path#section", split on the first "#"', () => {
    expect(sourceFileRef(item({ sourceKind: 'agent', agentTerminalId: 'a1', sourceSection: 'docs/plans/r.md#Owner decisions #2' })))
      .toEqual({ path: 'docs/plans/r.md', section: 'Owner decisions #2' });
    expect(sourceFileRef(item({ sourceKind: 'agent', agentTerminalId: 'a1', sourceSection: 'docs/plans/r.md' }))).toEqual({ path: 'docs/plans/r.md', section: null });
  });

  it('no file: an agent without a file, a PR, the overseer, no source', () => {
    expect(sourceFileRef(item({ sourceKind: 'agent', agentTerminalId: 'a1', sourceSection: '#Findings' }))).toBeNull();
    expect(sourceFileRef(item({ sourceKind: 'agent', sourceRef: 'Map researcher', sourceSection: 'Q2 part' }))).toBeNull();
    expect(sourceFileRef(item({ sourceKind: 'pr', sourceRef: '#26' }))).toBeNull();
    expect(sourceFileRef(item({ sourceKind: 'overseer' }))).toBeNull();
    expect(sourceFileRef(item({}))).toBeNull();
  });
});

describe('readSourceFile — the file under the project folder', () => {
  let base: string;
  let project: string;
  let outside: string;
  const write = (rel: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(base, rel)), { recursive: true });
    fs.writeFileSync(path.join(base, rel), text);
  };
  beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'source-file-'));
    project = path.join(base, 'project');
    outside = path.join(base, 'outside');
    write('project/docs/plans/readiness.md', '# Plan\n## Risks\nx\n');
    write('project/notes.txt', 'plain');
    write('outside/secret.md', '# secret');
  });
  afterEach(() => { fs.rmSync(base, { recursive: true, force: true }); });

  it('a markdown file inside the project: its text, its project path and its file name', () => {
    expect(readSourceFile(project, 'docs/plans/readiness.md')).toEqual({
      kind: 'file', path: 'docs/plans/readiness.md', file: 'readiness.md', fromMainCheckout: false, markdown: '# Plan\n## Risks\nx\n',
    });
    expect(readSourceFile(project, './docs/../docs/plans/readiness.md')).toMatchObject({ kind: 'file', path: 'docs/plans/readiness.md' });
  });

  it('an absolute path is accepted only inside the project', () => {
    expect(readSourceFile(project, path.join(project, 'docs/plans/readiness.md'))).toMatchObject({ kind: 'file', path: 'docs/plans/readiness.md' });
    expect(readSourceFile(project, path.join(fs.realpathSync(project), 'docs/plans/readiness.md'))).toMatchObject({ kind: 'file', path: 'docs/plans/readiness.md' });
    expect(readSourceFile(project, path.join(outside, 'secret.md'))).toEqual({ kind: 'outside' });
  });

  it('refuses "../" out of the project, even when the file exists', () => {
    expect(readSourceFile(project, '../outside/secret.md')).toEqual({ kind: 'outside' });
    expect(readSourceFile(project, 'docs/../../outside/secret.md')).toEqual({ kind: 'outside' });
  });

  it('refuses a symlink that points outside, as a file or as a folder on the way', () => {
    fs.symlinkSync(path.join(outside, 'secret.md'), path.join(project, 'docs/link.md'));
    fs.symlinkSync(outside, path.join(project, 'docs/out'));
    expect(readSourceFile(project, 'docs/link.md')).toEqual({ kind: 'outside' });
    expect(readSourceFile(project, 'docs/out/secret.md')).toEqual({ kind: 'outside' });
  });

  it('a symlink that stays inside the project is fine', () => {
    fs.symlinkSync(path.join(project, 'docs/plans/readiness.md'), path.join(project, 'docs/same.md'));
    expect(readSourceFile(project, 'docs/same.md')).toMatchObject({ kind: 'file', path: 'docs/same.md', file: 'same.md' });
  });

  it('a worktree under the project folder counts as inside', () => {
    write('project/.claude/worktrees/live-plan/docs/plans/new.md', '# New\n');
    expect(readSourceFile(project, '.claude/worktrees/live-plan/docs/plans/new.md')).toMatchObject({
      kind: 'file', path: '.claude/worktrees/live-plan/docs/plans/new.md', fromMainCheckout: false, markdown: '# New\n',
    });
  });

  it('the worktree is gone: the rest of the path in the project folder, flagged fromMainCheckout', () => {
    expect(readSourceFile(project, '.claude/worktrees/some-plan/docs/plans/readiness.md')).toEqual({
      kind: 'file', path: 'docs/plans/readiness.md', file: 'readiness.md', fromMainCheckout: true, markdown: '# Plan\n## Risks\nx\n',
    });
  });

  it('the file is gone, in the worktree and in the main checkout', () => {
    expect(readSourceFile(project, 'docs/plans/nope.md')).toEqual({ kind: 'gone' });
    expect(readSourceFile(project, '.claude/worktrees/some-plan/docs/plans/nope.md')).toEqual({ kind: 'gone' });
    expect(readSourceFile(path.join(base, 'no-project'), 'docs/plans/readiness.md')).toEqual({ kind: 'gone' });
  });

  it('markdown files only (.md, .markdown); other files, folders and files over 5 MB give the path only', () => {
    write('project/docs/UPPER.MD', '# Upper');
    write('project/docs/long.markdown', '# Long');
    expect(readSourceFile(project, 'docs/UPPER.MD')).toMatchObject({ kind: 'file' });
    expect(readSourceFile(project, 'docs/long.markdown')).toMatchObject({ kind: 'file' });
    expect(readSourceFile(project, 'notes.txt')).toEqual({ kind: 'file-only', path: 'notes.txt', file: 'notes.txt', fromMainCheckout: false, reason: NOT_MARKDOWN_REASON });
    expect(readSourceFile(project, 'docs/plans')).toEqual({ kind: 'file-only', path: 'docs/plans', file: 'plans', fromMainCheckout: false, reason: FOLDER_REASON });
    expect(SOURCE_MAX_BYTES).toBe(5 * 1024 * 1024);
    write('project/docs/huge.md', 'x'.repeat(SOURCE_MAX_BYTES + 1));
    expect(readSourceFile(project, 'docs/huge.md')).toMatchObject({ kind: 'file-only', reason: TOO_LARGE_REASON });
    expect([NOT_MARKDOWN_REASON, FOLDER_REASON, TOO_LARGE_REASON]).toEqual([
      'This file is not markdown, so the panel cannot show a section of it.',
      'This source is a folder, not a file.',
      'This file is larger than 5 MB, so the panel does not show it.',
    ]);
  });
});
