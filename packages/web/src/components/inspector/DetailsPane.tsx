import { useEffect, useMemo, useState } from 'react';
import { api } from '../../api/client';
import { useProjects } from '../../stores/projects';
import { useActivity } from '../../stores/activity';
import { useTabs, findTerminal } from '../../stores/tabs';
import type { Terminal } from '../../api/types';
import { useUsageLimits, UsageLimitsRows } from './UsageLimitsSection';
import { useAccounts, threadAccount } from '../../stores/accounts';
import { useActiveModel, activeModelOf } from '../../stores/activeModel';
import { can } from '../../lib/profile';
import { friendlyModelName } from '../../lib/modelName';
import { ThreadMenu, type ThreadMenuAt } from '../sidebar/ThreadMenu';

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '3px 0' }}>
      <span style={{ color: 'var(--color-text-secondary)' }}>{label}</span>
      <span style={{ fontFamily: mono ? 'var(--font-mono)' : undefined, color: 'var(--color-text-primary)', fontSize: mono ? 11 : 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 200 }}>{value}</span>
    </div>
  );
}

function homePath(p: string): string {
  return (p || '').replace(/^\/Users\/[^/]+/, '~').replace(/^\/home\/[^/]+/, '~');
}

const label: React.CSSProperties = { font: '500 10px var(--font-mono)', letterSpacing: '1.2px', color: 'var(--color-text-tertiary)' };

/**
 * The thread's facts, then its actions (owner, 2026-11-13): the right-click menu's own tiles and rows, so
 * the desktop right column, the phone's Thread details and the menu always match.
 */
export function DetailsPane({ projectId, terminalId }: { projectId: string | null; terminalId: string | null }) {
  const machine = can('details.machine');
  const project = useProjects((s) => s.sessions.find((x) => x.id === projectId)) ?? null;
  const activity = useActivity((s) => (terminalId ? s.byTerminal[terminalId] : undefined));
  const activeModels = useActiveModel((s) => s.byTerminal);
  const tab = useTabs((s) => (terminalId ? findTerminal(s.byProject, terminalId) : null));
  // The menu's anchor for the in-place actions: the same object while the thread is the same, so the menu does not reset.
  const menuAt = useMemo<ThreadMenuAt | null>(() => (tab ? { tab, x: 0, y: 0 } : null), [tab]);
  const [term, setTerm] = useState<Terminal | null>(null);
  const [branch, setBranch] = useState<string | null>(null);
  // The account the thread runs on (multi-account, 2026-11-06), with a switch.
  const accountsView = useAccounts((s) => s.view);
  useEffect(() => { void useAccounts.getState().load(); }, []);
  const account = threadAccount(accountsView, tab ?? term);
  // Limits belong to the account: refetch when a turn updates the thread's numbers.
  const limitsRows = useUsageLimits(terminalId, `${activity?.tokens ?? ''}|${activity?.cost ?? ''}`);

  // The terminal's own working dir + pid — the data that used to live in the
  // bottom bar below the terminal, now surfaced here in the right column.
  useEffect(() => {
    let live = true; setTerm(null);
    if (terminalId) api.getTerminal(terminalId).then((t) => { if (live) setTerm(t); }).catch(() => {});
    return () => { live = false; };
  }, [terminalId]);

  useEffect(() => {
    let live = true; setBranch(null);
    if (projectId) api.getGitInfo(projectId).then((g) => { if (live) setBranch(g.branch); }).catch(() => {});
    return () => { live = false; };
  }, [projectId]);

  if (!project) return <div style={{ padding: 12, color: 'var(--color-text-tertiary)' }}>No project selected</div>;
  const prettyModel = tab && tab.type !== 'shell' ? activeModelOf(activeModels, tab) : undefined;

  const hasActivity = !!(activity?.model || activity?.tokens || activity?.cost);
  const lim = limitsRows;
  const showDetails = hasActivity || !!lim;
  const status = tab?.status ?? term?.status;
  return (
    <div style={{ padding: 12, fontSize: 13 }}>
      {showDetails && (
        <>
          <div style={{ ...label, marginBottom: 8 }}>THREAD DETAILS</div>
          {activity?.model && <Row label="Model" value={activity.model} />}
          {activity?.context && <Row label="Context" value={activity.context} />}
          {activity?.tokens && <Row label="Tokens" value={activity.tokens} />}
          {activity?.cost && <Row label="Cost" value={activity.cost} />}
          {lim && <div style={{ marginTop: hasActivity ? 6 : 0 }}><UsageLimitsRows lim={lim} row={(l, v) => <Row label={l} value={v} />} /></div>}
        </>
      )}
      {terminalId && (
        <>
          <div style={{ ...label, margin: showDetails ? '14px 0 8px' : '0 0 8px' }}>THREAD</div>
          {tab?.label && <Row label="Name" value={tab.label} />}
          {/* Pretty has no CLI status line for activity.model: show the active model instead. */}
          {!activity?.model && prettyModel && <Row label="Model" value={friendlyModelName(prettyModel) ?? prettyModel} />}
          {/* Machine facts (ID, folder, branch, PID, tool servers, provider) are developer detail (lib/profile.ts 'details.machine'). */}
          {machine && <Row label="ID" value={terminalId} mono />}
          {machine && term?.workingDir && <Row label="Directory" value={homePath(term.workingDir)} mono />}
          {machine && branch && <Row label="Branch" value={`⎇ ${branch}`} mono />}
          {machine && term?.pid != null && <Row label="PID" value={String(term.pid)} mono />}
          {/* Every MCP server the thread was launched with (docs/superpowers/specs/2026-11-07-plugins-design.md, section 3.3). */}
          {machine && Array.isArray((term?.config as { toolsAvailable?: unknown } | undefined)?.toolsAvailable) && ((term!.config as { toolsAvailable: string[] }).toolsAvailable.length > 0) && (
            <Row label="Tools" value={(term!.config as { toolsAvailable: string[] }).toolsAvailable.join(', ')} mono />
          )}
          {status && <Row label="Status" value={status} />}
          {account && <Row label="Account" value={account.pinned ? account.label : `${account.label} (default)`} />}
        </>
      )}
      <div style={{ ...label, margin: '14px 0 8px' }}>PROJECT</div>
      <Row label="Name" value={project.name} />
      {machine && <Row label="Directory" value={homePath(project.workingDir)} mono />}
      {machine && <Row label="Provider" value={project.provider} />}
      <Row label="Status" value={project.status} />
      {terminalId && tab && (
        <div style={{ marginTop: 14, marginInline: -4 }}>
          <ThreadMenu at={menuAt} inline onClose={() => {}} onBranched={(b) => useTabs.getState().openTab(b.id)} />
        </div>
      )}
    </div>
  );
}
