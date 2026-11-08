import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { buildSdk } from './sdk';
import { useProjects } from '../stores/projects';
// The bundled Previews plugin is plain JS.
import activate, { looksLikeMarkdown } from '../../../plugins/previews/web.js';

const REPORT = '# POLYWOOD — local performance improvements\n\nUpdated 2026-11-08. This report describes **27 retained improvement groups**.\n\n## Results\n\n- LCP down 0.4 s\n- CLS unchanged';

describe('looksLikeMarkdown (2026-11-08)', () => {
  it('a title that ends in .md is markdown', () => expect(looksLikeMarkdown('plain words', 'NOTES.md')).toBe(true));
  it('a heading with bold or a list is markdown', () => expect(looksLikeMarkdown(REPORT, 'Report')).toBe(true));
  it('a URL, a command or a token is not', () => {
    expect(looksLikeMarkdown('https://example.com/a?b=c', 'Link')).toBe(false);
    expect(looksLikeMarkdown('./bin/dispatch update', 'Command')).toBe(false);
    expect(looksLikeMarkdown('sk-abc123', 'Token')).toBe(false);
  });
  it('one markdown-ish mark alone is not enough', () => expect(looksLikeMarkdown('Use **this** one', 'Hint')).toBe(false));
});

const doc = (id: string, title: string, text: string) =>
  ({ id, sessionId: 's1', sessionName: 'Alpha', terminalId: 't1', terminalLabel: 'Perf', title, note: null, text, files: [], createdAt: '2026-11-08T10:00:00Z', seenAt: 'seen' });

describe('a markdown text preview reads as a document (2026-11-08)', () => {
  let History: React.ComponentType;
  beforeEach(() => {
    useProjects.setState({ sessions: [{ id: 's1', name: 'Alpha' }] as never });
    const base = buildSdk();
    const views: { Component: React.ComponentType }[] = [];
    const DOCS = [doc('md', 'LOCAL-IMPROVEMENTS.md', REPORT), doc('cmd', 'Update command', './bin/dispatch update')];
    const d = {
      ...base, id: 'previews',
      storage: { ...base.storage, all: vi.fn(async () => DOCS.map((v) => ({ key: `preview:${v.id}`, value: v }))), set: vi.fn(async () => {}) },
      events: { on: () => () => {} },
      register: (_id: string, c: { views: { Component: React.ComponentType }[] }) => { views.push(...c.views); },
    };
    activate(d as never);
    History = views[0].Component;
  });

  it('renders the markdown (a heading, bold, a list), not raw code, with Read and Copy text', async () => {
    render(<History />);
    const body = await screen.findByTestId('preview-doc');
    expect(body.querySelector('h1')).toHaveTextContent('POLYWOOD — local performance improvements');
    expect(body.querySelector('strong')).toHaveTextContent('27 retained improvement groups');
    expect(body.querySelectorAll('li')).toHaveLength(2);
    expect(body.textContent).not.toContain('**');
    expect(screen.getByRole('button', { name: 'Read LOCAL-IMPROVEMENTS.md' })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Copy text' })).toHaveLength(2);
  });

  it('Read opens the full-screen reader with the whole document', async () => {
    render(<History />);
    fireEvent.click(await screen.findByRole('button', { name: 'Read LOCAL-IMPROVEMENTS.md' }));
    const dialog = await screen.findByRole('dialog');
    expect(await screen.findAllByText('CLS unchanged')).not.toHaveLength(0);
    expect(dialog).toBeInTheDocument();
  });

  it('a command keeps the monospace box you can select at once', async () => {
    render(<History />);
    const pre = await screen.findByTestId('preview-text');
    expect(pre.tagName).toBe('PRE');
    expect(pre).toHaveTextContent('./bin/dispatch update');
  });
});
