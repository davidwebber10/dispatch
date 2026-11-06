import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { test, expect, beforeEach, afterEach } from 'vitest';
import { closeAgentPane } from './closeAgentPane';
import { useAgents } from '../../stores/agents';
import { useAgentUI } from '../../stores/agentUI';
import { useTabs } from '../../stores/tabs';

const sched = { id: 'a1', projectId: 'p1', name: 'Nightly', provider: 'claude-code', enabled: true } as any;

beforeEach(() => {
  useAgents.setState({ schedules: [sched], runs: [], selectedId: 'a1' });
  useAgentUI.setState({ focused: true, editing: null });
});
afterEach(() => { cleanup(); useTabs.setState({ activeTabId: null }); });

// The page the pane returns to: a tab strip (when tabs exist) and the sidebar pills.
function Page() {
  const focused = useAgentUI((s) => s.focused);
  return (
    <div>
      <button data-automations-pill="p0">other project</button>
      <button data-automations-pill="p1">Automations p1</button>
      {!focused && <div data-tab-id="t1" tabIndex={-1}>tab one</div>}
    </div>
  );
}

test('closing moves focus to the tab that was active, and shows the tabs again', async () => {
  useTabs.setState({ activeTabId: 't1' });
  render(<Page />);
  closeAgentPane();
  expect(useAgentUI.getState().focused).toBe(false);
  await waitFor(() => expect(screen.getByText('tab one')).toHaveFocus());
});

test('with no active tab, focus goes to the Automations button of the automation\'s project', async () => {
  useTabs.setState({ activeTabId: null });
  render(<Page />);
  closeAgentPane();
  await waitFor(() => expect(screen.getByText('Automations p1')).toHaveFocus());
});

test('an active tab id with no tab on screen falls back to the Automations button', async () => {
  useTabs.setState({ activeTabId: 'gone' });
  render(<Page />);
  closeAgentPane();
  await waitFor(() => expect(screen.getByText('Automations p1')).toHaveFocus());
});
