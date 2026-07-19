import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { MobileSettingsList } from './MobileSettings';
import { SETTINGS_SECTIONS } from './sections';

// The mobile settings list is the level-0 rail screen behind the Settings bottom tab.
// It is deliberately dumb — it renders the shared section registry and reports which
// row was tapped, leaving navigation (history.pushState → level 1) to MobileApp.
describe('MobileSettingsList', () => {
  it('renders a row for every registered section', () => {
    render(<MobileSettingsList onOpen={() => {}} />);
    for (const s of SETTINGS_SECTIONS) expect(screen.getByText(s.label)).toBeTruthy();
  });

  it('reports the section key when a row is tapped', () => {
    const onOpen = vi.fn();
    render(<MobileSettingsList onOpen={onOpen} />);
    fireEvent.click(screen.getByText('Secrets'));
    expect(onOpen).toHaveBeenCalledWith('secrets');
  });

  it('stays in sync with the desktop modal by sharing one registry', () => {
    // Guards against a section being added to one shell but not the other.
    expect(SETTINGS_SECTIONS.map((s) => s.key)).toEqual(['general', 'integrations', 'secrets', 'tools', 'transcription']);
  });
});
