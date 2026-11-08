import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, within, cleanup } from '@testing-library/react';
import { Bell } from '@phosphor-icons/react';
import { SettingsPage, SettingsGroup, SettingsRow, ToneDot, StatusMark, TONE_VAR, IconTile, SettingsSubPage, SettingsDisclosure, EmptyState, dangerBtn, ghostBtn, fieldFor } from './ui';

afterEach(() => cleanup());

describe('SettingsPage (the page shell: one intro line over the groups)', () => {
  it('shows the intro line and the groups under it', () => {
    render(<SettingsPage intro="Plugins add screens."><SettingsGroup title="Bundled"><SettingsRow label="Coach" /></SettingsGroup></SettingsPage>);
    expect(screen.getByTestId('settings-page')).toBeInTheDocument();
    expect(screen.getByText('Plugins add screens.')).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Bundled' })).toBeInTheDocument();
  });
  it('has no intro element when none is given', () => {
    render(<SettingsPage><div>x</div></SettingsPage>);
    expect(screen.queryByTestId('settings-intro')).toBeNull();
  });
});

describe('SettingsRow variants', () => {
  it('onClick makes the row one button with a value and a chevron', () => {
    const onClick = vi.fn();
    render(<SettingsGroup title="Theme"><SettingsRow label="Theme" hint="How Dispatch looks." value="Dispatch Dark" onClick={onClick} /></SettingsGroup>);
    const b = screen.getByRole('button', { name: /Theme/ });
    expect(within(b).getByText('Dispatch Dark')).toBeInTheDocument();
    expect(within(screen.getByTestId('settings-row')).getByTestId('row-chevron')).toBeInTheDocument();
    fireEvent.click(b);
    expect(onClick).toHaveBeenCalledTimes(1);
    // A click anywhere on the row opens it too (the whole row is the target on a phone).
    fireEvent.click(screen.getByTestId('row-chevron'));
    expect(onClick).toHaveBeenCalledTimes(2);
  });
  it('a row without onClick has no button and no chevron', () => {
    render(<SettingsRow label="Plain" value="On" />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByTestId('row-chevron')).toBeNull();
    expect(screen.getByText('On')).toBeInTheDocument();
  });
  it('danger paints the label red', () => {
    render(<SettingsRow label="Remove plugin" danger onClick={() => {}} />);
    expect(screen.getByText('Remove plugin')).toHaveStyle({ color: 'var(--color-status-red)' });
  });
  it('icon puts an icon tile before the label', () => {
    render(<SettingsRow label="Notifications" icon={Bell} />);
    expect(screen.getByTestId('icon-tile')).toBeInTheDocument();
  });
  it('a click on the control of a clickable row does not open the row', () => {
    const onClick = vi.fn(); const onToggle = vi.fn();
    render(<SettingsRow label="Coach" onClick={onClick} control={<button type="button" onClick={onToggle}>switch</button>} />);
    fireEvent.click(screen.getByRole('button', { name: 'switch' }));
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(onClick).not.toHaveBeenCalled();
  });
});

describe('ToneDot and StatusMark (a colored dot and a word)', () => {
  it('the dot takes the tone color token', () => {
    render(<ToneDot tone="red" />);
    expect(screen.getByTestId('tone-dot')).toHaveStyle({ background: TONE_VAR.red });
  });
  it('the mark shows the word in the tone color', () => {
    render(<StatusMark tone="accent">Connected</StatusMark>);
    const m = screen.getByTestId('status-mark');
    expect(m).toHaveTextContent('Connected');
    expect(m).toHaveStyle({ color: TONE_VAR.accent });
  });
});

describe('IconTile', () => {
  it('renders the icon in a square tile of the given size', () => {
    render(<IconTile icon={Bell} size={48} />);
    expect(screen.getByTestId('icon-tile')).toHaveStyle({ width: '48px', height: '48px' });
  });
});

describe('SettingsSubPage (a page pushed from a row: back, header, groups)', () => {
  it('shows the back link only when onBack is given, and calls it', () => {
    const onBack = vi.fn();
    const { rerender } = render(<SettingsSubPage title="Coach" backLabel="Plugins" onBack={onBack}><div>body</div></SettingsSubPage>);
    fireEvent.click(screen.getByRole('button', { name: 'Back to plugins' }));
    expect(onBack).toHaveBeenCalledTimes(1);
    rerender(<SettingsSubPage title="Coach" backLabel="Plugins"><div>body</div></SettingsSubPage>);
    expect(screen.queryByRole('button', { name: 'Back to plugins' })).toBeNull();
  });
  it('the header has the title, the subtitle, the description and the icon', () => {
    render(<SettingsSubPage title="Coach" subtitle="v1.0.0 · Bundled" description="Small next steps." icon={Bell}><div>body</div></SettingsSubPage>);
    const h = screen.getByTestId('subpage-header');
    expect(within(h).getByText('Coach')).toBeInTheDocument();
    expect(within(h).getByText('v1.0.0 · Bundled')).toBeInTheDocument();
    expect(within(h).getByText('Small next steps.')).toBeInTheDocument();
    expect(within(h).getByTestId('icon-tile')).toBeInTheDocument();
    expect(screen.getByText('body')).toBeInTheDocument();
  });
});

describe('SettingsDisclosure (folded rows: Developer, Advanced)', () => {
  it('is closed at first; a click shows the rows and sets aria-expanded', () => {
    render(<SettingsDisclosure label="Developer" hint="Paths and ids."><SettingsRow label="Folder" /></SettingsDisclosure>);
    const b = screen.getByRole('button', { name: /Developer/ });
    expect(b).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Folder')).toBeNull();
    fireEvent.click(b);
    expect(b).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Folder')).toBeInTheDocument();
  });
  it('defaultOpen starts it open', () => {
    render(<SettingsDisclosure label="Advanced" defaultOpen><SettingsRow label="Limits" /></SettingsDisclosure>);
    expect(screen.getByText('Limits')).toBeInTheDocument();
  });
});

describe('EmptyState', () => {
  it('says what is missing and offers the action', () => {
    const onClick = vi.fn();
    render(<EmptyState action={<button type="button" onClick={onClick}>Add a server</button>}>No servers yet.</EmptyState>);
    expect(screen.getByTestId('empty-state')).toHaveTextContent('No servers yet.');
    fireEvent.click(screen.getByRole('button', { name: 'Add a server' }));
    expect(onClick).toHaveBeenCalled();
  });
});

describe('button and field styles', () => {
  it('dangerBtn is the ghost button in red', () => {
    expect(dangerBtn.color).toBe('var(--color-status-red)');
    expect(dangerBtn.height).toBe(ghostBtn.height);
  });
  it('fieldFor gives the phone 16px text and a 36px box (no iOS zoom)', () => {
    expect(fieldFor(true)).toMatchObject({ height: 36, fontSize: 16 });
    expect(fieldFor(false)).toMatchObject({ height: 30 });
  });
});
