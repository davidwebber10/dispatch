import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { ControlPlaneAnalytics } from './ControlPlaneAnalytics';
import { api } from '../../api/client';
import { useAnalyticsFeed } from '../../stores/analytics';
import { CP_FIXTURE } from './controlPlaneFixture';

/** After the tracking start below, so the token caption carries no "since" note. */
const FROM = '2026-09-01T00:00:00.000Z';

function stub(payload = CP_FIXTURE) {
  const spy = vi.spyOn(api, 'analyticsControlPlane').mockResolvedValue(payload);
  vi.spyOn(api, 'analyticsTracking').mockResolvedValue({ trackingStartedAt: '2026-08-15T00:00:00.000Z' });
  return spy;
}

describe('ControlPlaneAnalytics', () => {
  beforeEach(() => { vi.restoreAllMocks(); useAnalyticsFeed.setState({ rev: 0 }); });

  it('renders the six KPI tiles with their captions', async () => {
    stub();
    render(<ControlPlaneAnalytics from={FROM} projectId="" provider="" />);
    // 'SESSIONS' is also a table header, so wait on the tile's own caption.
    await waitFor(() => expect(screen.getByText('5 active · 1 new in range')).toBeTruthy());
    expect(screen.getByText('days with a Control Plane turn')).toBeTruthy();
    expect(screen.getByText('437')).toBeTruthy();
    expect(screen.getByText('27%')).toBeTruthy();
    expect(screen.getByText('1.6B of 6.1B Control Plane and agent tokens')).toBeTruthy();
    expect(screen.getByLabelText('No working or queued agent, and no activity for 7 days.')).toBeTruthy();
  });

  it('adds the tracking date to the token caption when the range starts before tracking', async () => {
    stub();
    render(<ControlPlaneAnalytics projectId="" provider="" />);
    await waitFor(() => expect(screen.getByText(/Control Plane and agent tokens · since /)).toBeTruthy());
  });

  it('sends the filters to the daemon', async () => {
    const spy = stub();
    render(<ControlPlaneAnalytics from={FROM} projectId="p1" provider="codex" />);
    await waitFor(() => expect(spy).toHaveBeenCalledWith({ from: FROM, projectId: 'p1', provider: 'codex' }));
  });

  it('folds projects with no activity into one footer row whose sessions add up', async () => {
    stub();
    render(<ControlPlaneAnalytics from={FROM} projectId="" provider="" />);
    await waitFor(() => expect(screen.getAllByText('PW Legacy').length).toBeGreaterThan(0));
    expect(screen.queryByText('Sandbox')).toBeNull();
    expect(screen.getByText('2 more projects · 3 sessions · no activity in range')).toBeTruthy();
  });

  it('shows the mission status as text, not only color', async () => {
    stub();
    render(<ControlPlaneAnalytics from={FROM} projectId="" provider="" />);
    await waitFor(() => expect(screen.getByText('Sage consumers')).toBeTruthy());
    expect(screen.getByText('Active')).toBeTruthy();
    expect(screen.getByText('Completed')).toBeTruthy();
    expect(screen.getByText('14 days')).toBeTruthy();
  });

  it('shows the CLI mix and the mean turn time per agent type', async () => {
    stub();
    render(<ControlPlaneAnalytics from={FROM} projectId="" provider="" />);
    await waitFor(() => expect(screen.getByText('codex 19 · claude-code 11')).toBeTruthy());
    expect(screen.getByText('4m 15s')).toBeTruthy();
  });

  it('shows the message totals in the block note, not an average', async () => {
    stub();
    render(<ControlPlaneAnalytics from={FROM} projectId="" provider="" />);
    await waitFor(() => expect(screen.getByText('30 from you · 25 to agents')).toBeTruthy());
  });

  it('fetches again when the daemon reports new data', async () => {
    const spy = stub();
    render(<ControlPlaneAnalytics from={FROM} projectId="" provider="" />);
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    act(() => { useAnalyticsFeed.setState({ rev: 1 }); });
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
  });

  it('says there is no activity instead of drawing empty charts', async () => {
    stub({ ...CP_FIXTURE, agentsByDay: [], tokensByDay: [], messagesByDay: [] });
    render(<ControlPlaneAnalytics from={FROM} projectId="" provider="" />);
    await waitFor(() => expect(screen.getAllByText('No Control Plane activity in this range.')).toHaveLength(3));
  });
});
