import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useSubPage } from './subPageNav';
import { useMobileNav } from '../../stores/mobileNav';

// The one sub-page hook every settings section uses (2026-11-07): plain state on the desktop; on the
// phone one history entry above the section, with the open item's id and title in stores/mobileNav
// so MobileApp can name the page in its header.

function Probe({ section }: { section: string }) {
  const nav = useSubPage(section);
  return (
    <div>
      <span data-testid={`open-${section}`}>{nav.openId ?? 'none'}</span>
      <span data-testid={`back-${section}`}>{String(nav.backLink)}</span>
      <button type="button" onClick={() => nav.open('work', 'Work')}>open {section}</button>
      <button type="button" onClick={nav.close}>close {section}</button>
      <button type="button" onClick={() => nav.retitle('Home')}>rename {section}</button>
    </div>
  );
}

const wide = window.innerWidth;
const setWidth = (w: number) => Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: w });

beforeEach(() => { useMobileNav.setState({ sub: null }); });
afterEach(() => { setWidth(wide); vi.unstubAllGlobals(); history.replaceState(null, ''); useMobileNav.setState({ sub: null }); });

describe('useSubPage', () => {
  it('on the desktop: plain state, no history entry, a back link', () => {
    history.replaceState({ nav: 0 }, '');
    render(<Probe section="accounts" />);
    expect(screen.getByTestId('back-accounts')).toHaveTextContent('true');
    fireEvent.click(screen.getByText('open accounts'));
    expect(screen.getByTestId('open-accounts')).toHaveTextContent('work');
    expect(history.state).toEqual({ nav: 0 });
    expect(useMobileNav.getState().sub).toBeNull();
    fireEvent.click(screen.getByText('close accounts'));
    expect(screen.getByTestId('open-accounts')).toHaveTextContent('none');
  });

  it('on the phone: one history entry above the section, with the id and title published for the header', () => {
    setWidth(390);
    history.replaceState({ nav: 1, settingsSection: 'accounts', depth: 1 }, '');
    render(<><Probe section="accounts" /><Probe section="agents" /></>);
    expect(screen.getByTestId('back-accounts')).toHaveTextContent('false');
    fireEvent.click(screen.getByText('open accounts'));
    expect(history.state).toMatchObject({ nav: 1, settingsSection: 'accounts', subPage: 'work', subTitle: 'Work', depth: 2 });
    expect(useMobileNav.getState().sub).toEqual({ section: 'accounts', id: 'work', title: 'Work' });
    expect(screen.getByTestId('open-accounts')).toHaveTextContent('work');
    // Another section's hook does not see it.
    expect(screen.getByTestId('open-agents')).toHaveTextContent('none');
    // Back (the header's arrow or the edge swipe) lands on the section's entry and closes the page.
    act(() => {
      history.replaceState({ nav: 1, settingsSection: 'accounts', depth: 1 }, '');
      window.dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
    });
    expect(screen.getByTestId('open-accounts')).toHaveTextContent('none');
    expect(useMobileNav.getState().sub).toBeNull();
  });

  it('on the phone, close walks back one entry', () => {
    setWidth(390);
    history.replaceState({ nav: 1, settingsSection: 'skills', depth: 1 }, '');
    const back = vi.spyOn(history, 'back').mockImplementation(() => {});
    render(<Probe section="skills" />);
    fireEvent.click(screen.getByText('open skills'));
    fireEvent.click(screen.getByText('close skills'));
    expect(back).toHaveBeenCalledTimes(1);
    back.mockRestore();
  });

  it('on the phone, retitle renames the open page in the store and its history entry', () => {
    setWidth(390);
    history.replaceState({ nav: 1, settingsSection: 'devices', depth: 1 }, '');
    render(<Probe section="devices" />);
    fireEvent.click(screen.getByText('open devices'));
    fireEvent.click(screen.getByText('rename devices'));
    expect(useMobileNav.getState().sub).toEqual({ section: 'devices', id: 'work', title: 'Home' });
    expect(history.state).toMatchObject({ settingsSection: 'devices', subPage: 'work', subTitle: 'Home' });
  });
});
