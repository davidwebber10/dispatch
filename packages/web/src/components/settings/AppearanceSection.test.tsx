import { render, screen, fireEvent, within } from '@testing-library/react';
import { describe, it, expect, beforeEach } from 'vitest';
import { AppearanceSection } from './AppearanceSection';
import { useSettings } from '../../stores/settings';
import { THEMES, getTheme, resolveTokens } from '../../themes';
import { pickOption } from '../../test/select';

/** jsdom serializes inline colors as rgb(r, g, b). */
const hexToRgb = (hex: string) => { const n = parseInt(hex.slice(1, 7), 16); return `rgb(${n >> 16}, ${(n >> 8) & 255}, ${n & 255})`; };

// Regression note: these suites render FRESH per case and assert the sibling setting did NOT
// change. A single-render, click-both-then-assert-both style test would still pass even if two
// handlers were swapped — that exact bug shape has slipped through twice on this project before.
beforeEach(() => {
  try { localStorage.clear(); } catch { /* ignore */ }
  // showPinnedFiles is reset here, not just in its own describe: it gates whether the
  // "Files shown" row renders at all, so a case that leaves it off would break the
  // sidebar-limit suite depending on file order.
  useSettings.setState({ showPinnedFiles: true });
});

/** The Theme row opens the theme picker in a sheet. */
function openThemes() {
  fireEvent.click(screen.getByRole('button', { name: /^Theme:/ }));
  return screen.getByRole('dialog', { name: 'Theme' });
}

describe('AppearanceSection — layout (2026-11-07 settings standard)', () => {
  it('shows grouped cards, a one-line intro and no mono "THIS DEVICE" banner', () => {
    render(<AppearanceSection />);
    expect(screen.queryByText(/THIS DEVICE ·/)).toBeNull();
    expect(screen.getByTestId('settings-intro').textContent).toMatch(/this device/i);
    for (const name of ['Theme', 'Text size', 'Sidebar', 'Terminal', 'Workspace']) {
      expect(screen.getByRole('group', { name })).toBeInTheDocument();
    }
  });

  it('the Theme row names the theme in use, and the 13 tiles live in the picker, not on the page', () => {
    useSettings.getState().setTheme('dracula');
    render(<AppearanceSection />);
    expect(screen.queryByRole('radiogroup', { name: 'Theme' })).toBeNull();
    expect(screen.getByRole('button', { name: /^Theme:/ }).textContent).toContain('Dracula');
    useSettings.getState().setTheme('dispatch-dark');
  });

  it('picking an accent swatch saves it and marks it', () => {
    useSettings.getState().setAccent('');
    render(<AppearanceSection />);
    fireEvent.click(screen.getByRole('button', { name: 'Accent #5E5CE6' }));
    expect(useSettings.getState().accent).toBe('#5E5CE6');
    expect(screen.getByRole('button', { name: 'Accent #5E5CE6' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Theme default accent' })).toHaveAttribute('aria-pressed', 'false');
    useSettings.getState().setAccent('');
  });

  it('density is a segmented choice that saves at once', () => {
    useSettings.setState({ density: 'cozy' });
    render(<AppearanceSection />);
    const seg = screen.getByRole('radiogroup', { name: 'Density' });
    fireEvent.click(within(seg).getByRole('radio', { name: 'Roomy' }));
    expect(useSettings.getState().density).toBe('roomy');
  });
});

describe('AppearanceSection — what moved in, what left', () => {
  it('the theme picker: System, then the light themes, then the dark themes', () => {
    render(<AppearanceSection />);
    const group = within(openThemes()).getByRole('radiogroup', { name: 'Theme' });
    const names = within(group).getAllByRole('radio').map((r) => r.getAttribute('aria-label'));
    expect(names).toEqual(['System', ...THEMES.filter((t) => t.kind === 'light').map((t) => t.name), ...THEMES.filter((t) => t.kind === 'dark').map((t) => t.name)]);
    expect(names).toHaveLength(13);
  });

  it('the Theme row comes first on the page, before the accent swatches', () => {
    render(<AppearanceSection />);
    const row = screen.getByRole('button', { name: /^Theme:/ });
    const accent = screen.getByLabelText('Accent #3ECF6A');
    expect(row.compareDocumentPosition(accent) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('marks the theme in use, and selecting one applies it at once', () => {
    useSettings.getState().setTheme('dispatch-dark');
    render(<AppearanceSection />);
    openThemes();
    expect(screen.getByRole('radio', { name: 'Dispatch Dark' })).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(screen.getByRole('radio', { name: 'Nord' }));
    expect(useSettings.getState().theme).toBe('nord');
    expect(screen.getByRole('radio', { name: 'Nord' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: 'Dispatch Dark' })).toHaveAttribute('aria-checked', 'false');
    expect(document.documentElement.style.getPropertyValue('--color-canvas')).toBe(resolveTokens(getTheme('nord')!).canvas);
    fireEvent.click(screen.getByRole('radio', { name: 'Dispatch Dark' }));
    expect(useSettings.getState().theme).toBe('dispatch-dark');
  });

  it('each theme shows a swatch preview of its background, pane, text and accent', () => {
    render(<AppearanceSection />);
    openThemes();
    const dracula = getTheme('dracula')!;
    const swatch = within(screen.getByRole('radio', { name: 'Dracula' })).getByTestId('theme-swatch');
    const html = swatch.outerHTML.toLowerCase();
    const tk = resolveTokens(dracula);
    for (const c of [tk.canvas, tk.pane, tk['text-primary'], tk.accent]) expect(html).toContain(hexToRgb(c));
  });

  it('the accent offers "Theme default", which follows the theme', () => {
    useSettings.getState().setTheme('nord');
    useSettings.getState().setAccent('#FF6AC1');
    render(<AppearanceSection />);
    fireEvent.click(screen.getByRole('button', { name: 'Theme default accent' }));
    expect(useSettings.getState().accent).toBe('');
    expect(document.documentElement.style.getPropertyValue('--color-accent')).toBe('#88C0D0');
    useSettings.getState().setTheme('dispatch-dark');
  });

  it('offers terminal autocorrect (also in the terminal + menu)', () => {
    useSettings.setState({ ptyAutocorrect: true });
    render(<AppearanceSection />);
    fireEvent.click(screen.getByRole('switch', { name: 'Autocorrect in the terminal composer' }));
    expect(useSettings.getState().ptyAutocorrect).toBe(false);
    expect(JSON.parse(localStorage.getItem('dispatch:ptyAutocorrect')!)).toBe(false);
  });

  it('offers the docs editor (also in Chat → Memory)', () => {
    useSettings.setState({ editor: '' });
    render(<AppearanceSection />);
    pickOption('Open docs in', 'Cursor');
    expect(useSettings.getState().editor).toBe('cursor');
  });

  it('labels its switches for screen readers', () => {
    render(<AppearanceSection />);
    for (const name of ['Pinned files', 'Pretty hint', 'Multi-pane tabs (Operator)']) {
      expect(screen.getByRole('switch', { name })).toBeInTheDocument();
    }
  });

  it('flipping Pretty hint never touches multi-pane', () => {
    useSettings.setState({ showPrettyHint: true, multiPane: true });
    render(<AppearanceSection />);
    fireEvent.click(screen.getByRole('switch', { name: 'Pretty hint' }));
    expect(useSettings.getState().showPrettyHint).toBe(false);
    expect(useSettings.getState().multiPane).toBe(true);
  });
});

// The Stepper renders bare −/+ buttons with no accessible names, so target the row by its
// label text: the settings row around the label holds the stepper's two buttons [dec, inc].
function limitRow(label: string) {
  const row = screen.getByText(label).closest('[data-testid="settings-row"]') as HTMLElement;
  const [dec, inc] = within(row).getAllByRole('button');
  return { row, dec, inc };
}

describe('AppearanceSection — sidebar list limits', () => {
  beforeEach(() => {
    useSettings.setState({ sidebarMaxThreads: 10, sidebarMaxFiles: 10 });
  });

  it('shows both limits at their default of 10', () => {
    render(<AppearanceSection />);
    expect(within(limitRow('Threads shown').row).getByText('10')).toBeInTheDocument();
    expect(within(limitRow('Files shown').row).getByText('10')).toBeInTheDocument();
  });

  it('stepping the thread limit up past 50 lands on All and persists 0', () => {
    useSettings.setState({ sidebarMaxThreads: 50 });
    render(<AppearanceSection />);
    fireEvent.click(limitRow('Threads shown').inc);
    expect(useSettings.getState().sidebarMaxThreads).toBe(0);
    expect(JSON.parse(localStorage.getItem('dispatch:sidebarMaxThreads')!)).toBe(0);
    expect(within(limitRow('Threads shown').row).getByText('All')).toBeInTheDocument();
  });

  it('stepping the file limit down from All lands on 50', () => {
    useSettings.setState({ sidebarMaxFiles: 0 });
    render(<AppearanceSection />);
    fireEvent.click(limitRow('Files shown').dec);
    expect(useSettings.getState().sidebarMaxFiles).toBe(50);
  });

  it('the two limits are independent — stepping threads never touches files', () => {
    render(<AppearanceSection />);
    fireEvent.click(limitRow('Threads shown').inc);
    expect(useSettings.getState().sidebarMaxThreads).toBe(11);
    expect(useSettings.getState().sidebarMaxFiles).toBe(10);
  });
});

describe('AppearanceSection — pinned files toggle', () => {
  const toggleFor = (label: string) => {
    const row = screen.getByText(label).closest('[data-testid="settings-row"]') as HTMLElement;
    return within(row).getByRole('switch');
  };

  it('ships on, so project cards keep showing pinned files until you say otherwise', () => {
    useSettings.setState({ showPinnedFiles: true });
    render(<AppearanceSection />);
    expect(screen.getByText('Pinned files')).toBeInTheDocument();
  });

  it('clicking the toggle turns pinned files off and persists it', () => {
    useSettings.setState({ showPinnedFiles: true });
    render(<AppearanceSection />);
    fireEvent.click(toggleFor('Pinned files'));
    expect(useSettings.getState().showPinnedFiles).toBe(false);
    expect(JSON.parse(localStorage.getItem('dispatch:showPinnedFiles')!)).toBe(false);
  });

  it('clicking it again on a fresh off render turns them back on', () => {
    useSettings.setState({ showPinnedFiles: false });
    render(<AppearanceSection />);
    fireEvent.click(toggleFor('Pinned files'));
    expect(useSettings.getState().showPinnedFiles).toBe(true);
  });

  it('the pinned-files toggle never touches the file limit', () => {
    useSettings.setState({ showPinnedFiles: true, sidebarMaxFiles: 10 });
    render(<AppearanceSection />);
    fireEvent.click(toggleFor('Pinned files'));
    expect(useSettings.getState().sidebarMaxFiles).toBe(10);
  });
});
