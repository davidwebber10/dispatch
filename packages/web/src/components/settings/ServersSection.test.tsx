import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ServersSection } from './ServersSection';
import { AboutSection } from './AboutSection';
import { useConnection } from '../../stores/connection';
import { useServers } from '../../stores/servers';
import { useSetup } from '../../stores/setup';
import { api } from '../../api/client';

const setWidth = (w: number) => Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: w });
const wide = window.innerWidth;

beforeEach(() => {
  useServers.setState({ servers: [{ label: 'Studio', origin: 'https://studio.example:3456' }] } as never);
  useConnection.setState({ status: 'connecting' } as never);
});
afterEach(() => { setWidth(wide); vi.restoreAllMocks(); });

describe('ServersSection', () => {
  it('lists the other machines with a labelled remove button', () => {
    setWidth(1200);
    render(<ServersSection />);
    expect(screen.getByText('Studio')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove Studio' })).toBeInTheDocument();
  });

  it('on desktop leaves the connection status to the nav DAEMON block (shown once)', () => {
    setWidth(1200);
    render(<ServersSection />);
    expect(screen.queryByTestId('connection-status')).toBeNull();
  });

  it('on a phone shows the status once, in the same words as the desktop nav', () => {
    setWidth(390);
    render(<ServersSection />);
    expect(screen.getByTestId('connection-status').textContent).toContain('Reconnecting…');
  });
});

describe('AboutSection', () => {
  it('re-runs the setup wizard and dismisses the settings chrome', () => {
    vi.spyOn(api, 'getTelemetrySetting').mockReturnValue(new Promise(() => {}));
    const open = vi.fn();
    useSetup.setState({ open } as never);
    const onDone = vi.fn();
    render(<AboutSection onDone={onDone} />);
    fireEvent.click(screen.getByRole('button', { name: 'Re-run setup wizard' }));
    expect(open).toHaveBeenCalled();
    expect(onDone).toHaveBeenCalled();
  });
});
