import { useCallback, useEffect, useState } from 'react';
import { CaretRight, ShieldWarning, ShieldCheck } from '@phosphor-icons/react';
import { api, type BlockedAction } from '../../../api/client';
import type { PendingPermission } from '../../../api/types';
import { Button } from '../../ui';

/** A plain title for what a thread wants to do (mirrors core os/approvals.ts approvalTitle). */
export function approvalTitle(toolName: string): string {
  const n = toolName.toLowerCase();
  if (n === 'bash' || n.includes('command') || n === 'execute' || n === 'shell') return 'Wants to run a command';
  if (/send.*(mail|email|message)|(mail|message)[a-z_-]*__send|gmail_send|email/.test(n)) return 'Wants to send an email';
  if (n === 'write' || n === 'edit' || n === 'multiedit' || n.includes('patch') || n.includes('edit')) return 'Wants to change a file';
  if (n === 'webfetch' || n === 'websearch' || n.includes('network') || n.includes('fetch')) return 'Wants to reach the internet';
  if (n.startsWith('mcp__')) return `Wants to use ${toolName.replace(/^mcp__/, '').replace(/__/g, ' › ')}`;
  return `Wants to use ${toolName}`;
}

function detailOf(input: unknown): string {
  if (!input || typeof input !== 'object') return typeof input === 'string' ? input : '';
  const o = input as Record<string, unknown>;
  const v = o.command ?? o.file_path ?? o.path ?? o.url;
  if (typeof v === 'string') return v;
  try { return JSON.stringify(input, null, 2); } catch { return ''; }
}

const card: React.CSSProperties = {
  border: '1px solid var(--color-border-strong)', borderRadius: 'var(--radius-md)', background: 'var(--color-elevated)',
  padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 8,
};

function Detail({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  if (!text) return null;
  return (
    <div>
      <button type="button" onClick={() => setOpen((o) => !o)} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--color-text-secondary)', fontSize: 12 }}>
        <CaretRight size={10} weight="bold" style={{ transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .12s' }} /> Details
      </button>
      {open && <pre style={{ margin: '6px 0 0', padding: '8px 10px', background: 'var(--color-pane)', borderRadius: 'var(--radius-sm)', font: '400 11.5px var(--font-mono)', whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 200, overflow: 'auto' }}>{text}</pre>}
    </div>
  );
}

/**
 * The in-thread approval cards, pinned above the composer so a waiting thread shows them without
 * scrolling: a gated tool the thread is waiting on (Allow once / Deny), and each action the harness
 * blocked by itself in smart approvals (Allow this / Keep blocked, with the classifier's or reviewer's
 * reason). The state is read again from the daemon on open, on reconnect and after each new event, so a
 * reload never loses a card. A question (AskUserQuestion) keeps its own card in the timeline.
 */
export function ApprovalCards({ terminalId, pending, refreshKey }: { terminalId: string; pending: PendingPermission | null; refreshKey: unknown }) {
  const [blocked, setBlocked] = useState<BlockedAction[]>([]);
  const [fetchedPending, setFetchedPending] = useState<PendingPermission | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    try {
      api.getApprovals(terminalId).then((a) => { setBlocked(a?.blocked ?? []); setFetchedPending(a?.pending ?? null); }).catch(() => { /* an older daemon */ });
    } catch { /* no such call (an older client build in a test) */ }
  }, [terminalId]);
  useEffect(() => { load(); }, [load, refreshKey]);

  const p = pending ?? fetchedPending;
  const gated = p && !p.questions?.length ? p : null;

  const answer = async (decision: 'allow' | 'deny') => {
    if (!gated) return;
    setBusy(gated.requestId); setError(null);
    try { await api.answerPermission(terminalId, { requestId: gated.requestId, decision, ...(decision === 'deny' ? { message: 'The person denied this. Do not try it again; ask them what to do instead.' } : {}) }); setFetchedPending(null); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); load(); }
    finally { setBusy(null); }
  };
  const resolve = async (b: BlockedAction, decision: 'allow' | 'keep') => {
    setBusy(b.id); setError(null);
    try { await api.resolveBlocked(terminalId, b.id, decision); setBlocked((l) => l.filter((x) => x.id !== b.id)); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); load(); }
    finally { setBusy(null); }
  };

  if (!gated && blocked.length === 0) return null;
  return (
    <div data-testid="approval-cards" style={{ flexShrink: 0, padding: '10px 14px 0', display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 768, width: '100%', margin: '0 auto', boxSizing: 'border-box' }}>
      {gated && (
        <div role="alert" data-testid="approval-pending" style={card}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 600, fontSize: 13.5, color: 'var(--color-text-primary)' }}>
            <ShieldWarning size={16} /> {approvalTitle(gated.toolName)}
          </div>
          <span style={{ fontSize: 12.5, color: 'var(--color-text-secondary)' }}>The thread waits for you before it does this.</span>
          <Detail text={detailOf(gated.input)} />
          <div style={{ display: 'flex', gap: 8 }}>
            <Button variant="primary" size="sm" disabled={busy !== null} onClick={() => void answer('allow')}>Allow once</Button>
            <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => void answer('deny')}>Deny</Button>
          </div>
        </div>
      )}
      {blocked.map((b) => (
        <div key={b.id} data-testid="approval-blocked" style={card}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 600, fontSize: 13.5, color: 'var(--color-text-primary)' }}>
            <ShieldCheck size={16} /> Blocked: {b.title.replace(/^Wants to /, '')}
          </div>
          <span style={{ fontSize: 12.5, color: 'var(--color-text-secondary)' }}>
            {b.reason ? `Reason: ${b.reason}` : 'The safety check stopped this action.'}{b.riskLevel ? ` (risk: ${b.riskLevel})` : ''}
          </span>
          <Detail text={b.detail ?? ''} />
          <div style={{ display: 'flex', gap: 8 }}>
            <Button variant="primary" size="sm" disabled={busy !== null} onClick={() => void resolve(b, 'allow')}>Allow this</Button>
            <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => void resolve(b, 'keep')}>Keep blocked</Button>
          </div>
        </div>
      ))}
      {error && <span role="alert" style={{ fontSize: 12.5, color: 'var(--color-status-red)' }}>{error}</span>}
    </div>
  );
}
