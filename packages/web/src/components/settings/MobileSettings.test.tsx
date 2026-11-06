import { render, screen, fireEvent, within } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { MobileSettingsList } from './MobileSettings';
import { SETTINGS_SECTIONS, settingsSection } from './sections';

// The mobile settings list is the level-0 rail screen behind the Settings bottom tab.
// It is deliberately dumb — it renders the shared section registry and reports which
// row was tapped, leaving navigation (history.pushState → level 1) to MobileApp.
describe('MobileSettingsList', () => {
  it('renders a row for every registered section', () => {
    render(<MobileSettingsList onOpen={() => {}} />);
    for (const s of SETTINGS_SECTIONS) expect(screen.getByText(s.label)).toBeTruthy();
  });

  it('groups the rows under YOU, AGENTS and THIS MAC, in that order', () => {
    render(<MobileSettingsList onOpen={() => {}} />);
    const regions = screen.getAllByRole('region');
    expect(regions.map((r) => r.getAttribute('aria-label'))).toEqual(['YOU', 'AGENTS', 'THIS MAC']);
    expect(within(regions[2]).getByText('Devices & access')).toBeTruthy();
  });

  it('reports the section key when a row is tapped', () => {
    const onOpen = vi.fn();
    render(<MobileSettingsList onOpen={onOpen} />);
    fireEvent.click(screen.getByText('Secrets'));
    expect(onOpen).toHaveBeenCalledWith('secrets');
  });

  it('stays in sync with the desktop page by sharing one registry', () => {
    // Guards against a section being added to one shell but not the other.
    expect(SETTINGS_SECTIONS.map((s) => s.key)).toEqual(['appearance', 'notifications', 'dictation', 'agents', 'accounts', 'usage', 'integrations', 'secrets', 'tools', 'devices', 'servers', 'about']);
  });

  it('resolves the keys from before the reorganisation', () => {
    expect(settingsSection('transcription')?.key).toBe('dictation');
    expect(settingsSection('harnesses')?.key).toBe('agents');
    expect(settingsSection('access')?.key).toBe('devices');
    expect(settingsSection('general')?.key).toBe('appearance');
  });
});
