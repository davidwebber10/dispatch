import { render, screen } from '@testing-library/react';
import { vi, beforeEach, afterEach, it, expect } from 'vitest';
import { TabHost } from './TabHost';
import { useTabs } from '../../stores/tabs';
import type { Terminal } from '../../api/types';

// The leaf tabs are heavy (CodeMirror, xterm, byte fetches) and are covered by their own suites.
// This file is about ROUTING only: which component does a given file path land in?
vi.mock('./FileEditorTab', () => ({ FileEditorTab: () => <div data-testid="file-editor" /> }));
vi.mock('./ImageFileTab', () => ({ ImageFileTab: () => <div data-testid="image-viewer" /> }));
vi.mock('./TerminalTab', () => ({ TerminalTab: () => <div data-testid="terminal" /> }));
vi.mock('./BrowserTab', () => ({ BrowserTab: () => <div data-testid="browser" /> }));
vi.mock('./NotesTab', () => ({ NotesTab: () => <div data-testid="notes" /> }));
vi.mock('./chat/ChatView', () => ({ ChatView: () => <div data-testid="chat" /> }));

function fileTab(path: string): Terminal {
  return {
    id: 't1', sessionId: 'p1', type: 'file', label: path, pid: null, externalId: null,
    workingDir: null, status: 'idle', createdAt: '', config: { path }, archivedAt: null, sortOrder: 0,
  } as unknown as Terminal;
}

/** Seed the store so TabHost renders from cache and never touches the network. */
function renderPath(path: string) {
  useTabs.setState({ byProject: { p1: [fileTab(path)] } });
  render(<TabHost terminalId="t1" />);
}

beforeEach(() => {
  useTabs.setState({ byProject: {} });
});
afterEach(() => {
  vi.restoreAllMocks();
});

it('routes a source file to the editor', () => {
  renderPath('src/index.ts');
  expect(screen.getByTestId('file-editor')).toBeInTheDocument();
  expect(screen.queryByTestId('image-viewer')).toBeNull();
});

it('routes a raster image to the image viewer', () => {
  renderPath('assets/logo.png');
  expect(screen.getByTestId('image-viewer')).toBeInTheDocument();
  expect(screen.queryByTestId('file-editor')).toBeNull();
});

it('routes an SVG to the EDITOR, not the image viewer — an SVG is text', () => {
  // Regression guard. isImage() includes 'svg' (correctly: the Files-pane Copy Image path
  // rasterizes it through a canvas), but SVG is TEXT — /files/read serves it perfectly and
  // languageFor() maps it to the html() CodeMirror mode. Routing it to ImageFileTab renders a
  // read-only picture and makes the source unreachable: a capability regression.
  renderPath('assets/icon.svg');
  expect(screen.getByTestId('file-editor')).toBeInTheDocument();
  expect(screen.queryByTestId('image-viewer')).toBeNull();
});

it('routes uppercase extensions the same way', () => {
  renderPath('ASSETS/ICON.SVG');
  expect(screen.getByTestId('file-editor')).toBeInTheDocument();
});
