import { useEffect, useRef, useState } from 'react';
import { ArrowSquareOut, SignIn, Info, ClockCounterClockwise, ArrowClockwise } from '@phosphor-icons/react';
import { useUsageLimits } from '../../stores/usageLimits';
import { whenLabel } from '../inspector/usageLimits';
import type { Account, UsageSummary } from '../../api/types';
import { api } from '../../api/client';
import { ClaudeLogin } from '../endless/ClaudeLogin';
import { usePrefersReducedMotion } from '../../hooks/usePrefersReducedMotion';
import { HARNESS_MARK } from '../common/HarnessStrip';
import { useAccounts, accountProviderOf, usageAccessOf, updatedAgo, USAGE_ACCESS_TEXT } from '../../stores/accounts';
import { ringModels, RING_COLOR, yellowFrom, bannerText, COUNTED, type RingModel, type RingRow } from './usageGauge';

/**
 * The usage sheet (2026-11-06, option A of the redesign): one card per tool, laid out like Claude's
 * own usage page. Each limit is a row: its name and how much is USED on the right, a thin bar that
 * fills as you use it (green, then yellow, then red), marks on the bar where yellow and red start,
 * and the reset time and run-out estimate underneath. Banked Codex resets sit below the limits.
 * The bars and numbers sweep into place when the sheet opens.
 *
 * Usage access (W1-H, 2026-11-09): a Claude account whose usage read is refused or limited says so at
 * the foot of its card (UsageAccessLine), from the accounts view. A refused account with no figure
 * at all still gets a card, so "Sign in again" has a place.
 */
const ANIM_MS = 700;
const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);

/** `used` eased from where it was to `target` over ANIM_MS (from 0 on first show). */
function useAnimatedUsed(target: number, reduced: boolean): number {
  const [shown, setShown] = useState(reduced ? target : 0);
  const from = useRef(reduced ? target : 0);
  useEffect(() => {
    if (reduced) { setShown(target); from.current = target; return; }
    const start = performance.now();
    const a = from.current;
    let raf = 0;
    const step = (t: number) => {
      const k = Math.min(1, Math.max(0, (t - start) / ANIM_MS));
      const eased = 1 - Math.pow(1 - k, 3); // ease-out
      const v = a + (target - a) * eased;
      setShown(v);
      from.current = v;
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, reduced]);
  return shown;
}

function LimitRow({ toolName, row, warn, first, dense }: { toolName: string; row: RingRow; warn: number; first: boolean; dense?: boolean }) {
  const reduced = usePrefersReducedMotion();
  const target = 100 - (row.left ?? 0);
  const used = useAnimatedUsed(target, reduced);
  const color = RING_COLOR[row.tone];
  const label = cap(row.label);
  // Where the colour changes: yellow from yellowFrom(warn), red from the warning level.
  const marks: [number, string][] = [[yellowFrom(warn), RING_COLOR.yellow], [warn, RING_COLOR.red]];
  const meter = (height: number, margin: string) => (
    <div role="meter" aria-label={`${toolName} ${row.label}: ${target}% used`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={target}
      style={{ position: 'relative', height, borderRadius: 'var(--radius-pill)', background: 'var(--color-hover)', margin }}>
      {used > 0.2 && <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${Math.max(1.2, Math.min(100, used))}%`, borderRadius: 'var(--radius-pill)', background: color }} />}
      {marks.map(([at, c]) => (
        <div key={at} aria-hidden style={{ position: 'absolute', left: `calc(${at}% - 1px)`, top: -2, bottom: -2, width: 2, borderRadius: 'var(--radius-xs)', background: c, opacity: 0.85 }} />
      ))}
    </div>
  );
  // Dense (the desktop flyout, 2026-11-09): the same facts on two short lines, the name, reset and
  // figure on one, a thin bar under it.
  if (dense) {
    const when = [row.reset ? cap(row.reset) : null, row.estimate].filter(Boolean).join(' · ');
    return (
      <div data-testid="usage-limit" style={{ padding: '7px 0', borderTop: first ? 'none' : '1px solid var(--color-border)' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, minWidth: 0 }}>
          <span style={{ fontSize: 13.5, fontWeight: 500, whiteSpace: 'nowrap' }}>{label}</span>
          {when && <span title={row.estimateTitle ?? undefined} style={{ fontSize: 11.5, color: 'var(--color-text-tertiary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }}>{when}</span>}
          <span style={{ marginLeft: 'auto', fontSize: 13.5, fontWeight: 600, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', color: row.tone === 'green' ? 'var(--color-text-primary)' : color }}>
            {Math.round(used)}%<span style={{ fontSize: 11.5, fontWeight: 400, color: 'var(--color-text-secondary)' }}> used</span>
          </span>
        </div>
        {meter(5, '6px 0 1px')}
      </div>
    );
  }
  return (
    <div data-testid="usage-limit" style={{ padding: '11px 0', borderTop: first ? 'none' : '1px solid var(--color-border)' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <span style={{ fontSize: 14.5, fontWeight: 500 }}>{label}</span>
        <span style={{ marginLeft: 'auto', fontSize: 14.5, fontWeight: 500, fontVariantNumeric: 'tabular-nums', color: row.tone === 'green' ? 'var(--color-text-primary)' : color }}>
          {Math.round(used)}% <span style={{ fontSize: 12.5, fontWeight: 400, color: 'var(--color-text-secondary)' }}>used</span>
        </span>
      </div>
      <div role="meter" aria-label={`${toolName} ${row.label}: ${target}% used`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={target}
        style={{ position: 'relative', height: 8, borderRadius: 'var(--radius-pill)', background: 'var(--color-hover)', margin: '9px 0 7px' }}>
        {used > 0.2 && <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${Math.max(1.2, Math.min(100, used))}%`, borderRadius: 'var(--radius-pill)', background: color }} />}
        {marks.map(([at, c]) => (
          <div key={at} aria-hidden style={{ position: 'absolute', left: `calc(${at}% - 1px)`, top: -3, bottom: -3, width: 2, borderRadius: 'var(--radius-xs)', background: c, opacity: 0.85 }} />
        ))}
      </div>
      {(row.reset || row.estimate) && (
        <div title={row.estimateTitle ?? undefined} style={{ fontSize: 12.5, color: 'var(--color-text-secondary)' }}>
          {row.reset ? cap(row.reset) : null}{row.reset && row.estimate ? ' · ' : ''}{row.estimate}
          {row.estimate && <span style={{ marginLeft: 5, font: '400 10px var(--font-mono)', color: 'var(--color-text-tertiary)', padding: '0 4px', borderRadius: 'var(--radius-xs)', border: '1px solid var(--color-border)' }}>EST</span>}
        </div>
      )}
    </div>
  );
}

/** The brand mark for a provider id (`claude-code` → the Claude mark). */
const MARK_KEY: Record<string, string> = { 'claude-code': 'claude', codex: 'codex', grok: 'grok', opencode: 'opencode' };

/** What the card says about the account's sign-in, and the next step. `figuresAt`: when the shown figures were taken. */
interface CardAccess { state: 'sign-in-needed' | 'not-available' | 'rate-limited'; accountId: string; label: string; isCli: boolean; figuresAt: number | null; now: number }

function UsageAccessLine({ access: a, dense, first }: { access: CardAccess; dense?: boolean; first: boolean }) {
  const [signing, setSigning] = useState(false);
  const size = dense ? 12.5 : 13.5;
  const line = (Icon: typeof Info, text: string) => (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6, fontSize: size, lineHeight: 1.4, color: 'var(--color-text-secondary)' }}>
      <Icon size={dense ? 14 : 15} style={{ flexShrink: 0, marginTop: 1.5 }} /><span style={{ minWidth: 0 }}>{text}</span>
    </div>
  );
  return (
    <div data-testid="usage-access" data-state={a.state} style={{ borderTop: first ? 'none' : '1px solid var(--color-border)', padding: dense ? '7px 0' : '11px 0', display: 'flex', flexDirection: 'column', gap: dense ? 6 : 8 }}>
      {a.state === 'not-available' && line(Info, USAGE_ACCESS_TEXT.notAvailable)}
      {a.state === 'rate-limited' && line(ClockCounterClockwise, a.figuresAt === null ? 'Claude limits how often usage is read. Dispatch reads again after a wait.' : updatedAgo(a.figuresAt, a.now))}
      {a.state === 'sign-in-needed' && (
        <>
          {line(SignIn, a.isCli ? USAGE_ACCESS_TEXT.signInCli : USAGE_ACCESS_TEXT.signIn)}
          {!a.isCli && !signing && (
            <button type="button" aria-label={`Sign in again to ${a.label}`} onClick={() => setSigning(true)}
              style={{ alignSelf: 'flex-start', display: 'inline-flex', alignItems: 'center', gap: 6, height: dense ? 26 : 30, padding: '0 12px', background: 'var(--color-accent)', border: 'none', borderRadius: 'var(--radius-md)', color: 'var(--color-on-accent)', fontSize: dense ? 12 : 13, fontWeight: 600, cursor: 'pointer' }}>
              <SignIn size={dense ? 13 : 14} weight="bold" />Sign in again
            </button>
          )}
          {/* The existing Claude login (open the page, paste the code), for THIS account: its token is replaced in place. */}
          {!a.isCli && signing && (
            <ClaudeLogin autoStart buttonLabel="Sign in again" start={() => api.accountsClaudeLogin(a.label, a.accountId)}
              onDone={() => { setSigning(false); void api.accountsCheckUsage(a.accountId).catch(() => {}).then(() => useAccounts.getState().reload()); }} />
          )}
        </>
      )}
    </div>
  );
}

function ToolCard({ m, warn, current, dense, email, access }: { m: RingModel; warn: number; current?: boolean; dense?: boolean; email?: string | null; access?: CardAccess | null }) {
  // A steady order (5-hour, then weekly, …), not closest-to-the-limit first, so rows never swap.
  const order = (t: string) => { const i = (COUNTED as readonly string[]).indexOf(t); return i < 0 ? 99 : i; };
  const rows = [...m.rows].sort((a, b) => order(a.type) - order(b.type));
  const Mark = HARNESS_MARK[MARK_KEY[m.provider] ?? ''];
  return (
    // Each card is its own block (2026-11-09: the cards blended together): a header band with the
    // tool's mark, a stronger edge, and room between the cards.
    <section aria-label={m.name} data-current={current ? 'true' : undefined} style={{ background: 'var(--color-elevated)', border: `1px solid ${current ? 'var(--color-accent)' : 'color-mix(in srgb, var(--color-text-emphasis) 16%, transparent)'}`, borderRadius: 'var(--radius-lg)', position: 'relative', marginTop: current ? 14 : 0, minWidth: 0, opacity: m.stale ? 0.75 : 1, boxShadow: '0 6px 18px -12px var(--color-shadow-strong)' }}>
      {/* The open thread's account (2026-11-09): a tab on the top-right of the green border, not a pill in the header. */}
      {current && (
        <span data-testid="usage-current-tab" style={{ position: 'absolute', right: 12, bottom: '100%', marginBottom: 0, padding: dense ? '2px 9px' : '3px 10px', borderRadius: 'var(--radius-md) var(--radius-md) 0 0', background: 'var(--color-accent)', color: 'var(--color-on-accent)', font: `700 ${dense ? 10 : 10.5}px var(--font-mono)`, letterSpacing: '.07em', textTransform: 'uppercase', whiteSpace: 'nowrap', lineHeight: 1.4 }}>This thread</span>
      )}
      <div data-testid="usage-card-header" style={{ borderRadius: 'var(--radius-lg) var(--radius-lg) 0 0', display: 'flex', alignItems: 'center', gap: dense ? 8 : 9, padding: dense ? '6px 12px' : '10px 14px', background: current ? 'color-mix(in srgb, var(--color-accent) 12%, transparent)' : 'color-mix(in srgb, var(--color-text-emphasis) 6%, transparent)', borderBottom: '1px solid var(--color-border)' }}>
        {Mark && <span aria-hidden style={{ width: dense ? 22 : 26, height: dense ? 22 : 26, flexShrink: 0, borderRadius: 'var(--radius-md)', background: 'var(--color-pane)', border: '1px solid var(--color-border)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}><Mark size={dense ? 13 : 15} /></span>}
        {/* The name, and under it the account's email when the daemon knows it (2026-11-09). */}
        <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flexShrink: 0 }}>
          <span style={{ fontSize: dense ? 14.5 : 16, fontWeight: 600, whiteSpace: 'nowrap', lineHeight: 1.25 }}>{m.name}</span>
          {email && <span data-testid="usage-card-email" title={email} style={{ font: `400 ${dense ? 11 : 11.5}px var(--font-mono)`, color: 'var(--color-text-tertiary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 220, lineHeight: 1.3 }}>{email}</span>}
        </span>
        {m.plan && <span style={{ font: '400 10.5px var(--font-mono)', letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--color-text-tertiary)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-pill)', padding: '1px 7px' }}>{m.plan}</span>}
        <span title={m.stale ? 'These figures are old: no thread has reported in a while' : undefined}
          style={{ marginLeft: 'auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', font: '400 11px var(--font-mono)', color: m.stale ? 'var(--color-status-yellow)' : 'var(--color-text-tertiary)', whiteSpace: 'nowrap' }}>{m.asOf}</span>
      </div>
      <div style={{ padding: dense ? '0 12px' : '0 14px' }}>
      {rows.map((r, i) => <LimitRow key={r.type} toolName={m.name} row={r} warn={warn} first={i === 0} dense={dense} />)}
      {/* Money and credits (2026-11-06): Claude's extra-usage spend this month, Codex's prepaid balance. */}
      {(m.spend || m.creditBalance) && (
        <div data-testid="usage-money" style={{ borderTop: rows.length ? '1px solid var(--color-border)' : 'none', padding: dense ? '7px 0' : '11px 0', display: 'flex', flexDirection: 'column', gap: dense ? 2 : 4 }}>
          {m.spend && <div style={{ fontSize: dense ? 12.5 : 13.5, color: 'var(--color-text-secondary)' }}>{m.spend}</div>}
          {m.creditBalance && <div style={{ fontSize: dense ? 12.5 : 13.5, color: 'var(--color-text-secondary)' }}>{m.creditBalance}</div>}
        </div>
      )}
      {m.credits > 0 && dense && (
        <div style={{ borderTop: '1px solid var(--color-border)', padding: '7px 0' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontSize: 13.5, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{m.credits}</span>
            <span style={{ fontSize: 13, whiteSpace: 'nowrap' }}>reset{m.credits === 1 ? '' : 's'} banked</span>
            {m.useUrl && (
              <a href={m.useUrl} target="_blank" rel="noopener noreferrer" aria-label={`Use a reset on the ${m.name} usage page`}
                style={{ marginLeft: 'auto', flexShrink: 0, display: 'inline-flex', alignItems: 'center', gap: 5, height: 24, padding: '0 9px', background: 'transparent', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', color: 'var(--color-text-primary)', fontSize: 12, fontWeight: 500, textDecoration: 'none' }}>
                Use<ArrowSquareOut size={12} weight="bold" />
              </a>
            )}
          </div>
          {m.creditList.length > 0 && (
            <div data-testid="reset-expiries" style={{ fontSize: 11.5, color: 'var(--color-text-tertiary)', marginTop: 3 }}>
              Expire{' '}
              {m.creditList.map((c, i) => (
                <span key={c.id} style={{ color: c.soon ? 'var(--color-status-yellow)' : undefined }}>{i > 0 ? ' · ' : ''}{c.expires ?? 'never'}{c.count > 1 ? ` ×${c.count}` : ''}</span>
              ))}
            </div>
          )}
        </div>
      )}
      {m.credits > 0 && !dense && (
        <div style={{ borderTop: '1px solid var(--color-border)', padding: '11px 0' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 15, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{m.credits}</span>
            <span style={{ fontSize: 14 }}>reset{m.credits === 1 ? '' : 's'} banked</span>
            {/* A reset is used on the tool's own usage page: ChatGPT (2026-11-06), claude.ai (2026-11-09). Codex's own app-server refuses the
                in-app spend until a limit is hit ("nothingToReset"), so the link is the way that works. */}
            {m.useUrl && (
              <a href={m.useUrl} target="_blank" rel="noopener noreferrer" aria-label={`Use a reset on the ${m.name} usage page`}
                style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 6, height: 30, padding: '0 12px', background: 'transparent', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', color: 'var(--color-text-primary)', fontSize: 13, fontWeight: 500, textDecoration: 'none' }}>
                Use<ArrowSquareOut size={13} weight="bold" />
              </a>
            )}
          </div>
          {m.creditList.length > 0 && (
            <div data-testid="reset-expiries" style={{ fontSize: 12, color: 'var(--color-text-tertiary)', marginTop: 6 }}>
              Expire{' '}
              {m.creditList.map((c, i) => (
                <span key={c.id} style={{ color: c.soon ? 'var(--color-status-yellow)' : undefined }}>{i > 0 ? ' · ' : ''}{c.expires ?? 'never'}{c.count > 1 ? ` ×${c.count}` : ''}</span>
              ))}
            </div>
          )}
        </div>
      )}
      {access && <UsageAccessLine access={access} dense={dense} first={rows.length === 0 && !m.spend && !m.creditBalance && m.credits === 0} />}
      </div>
    </section>
  );
}

/**
 * The Refresh row (2026-11-09): the figures are read on a clock, not live, so the owner can ask for
 * a read now. It says when the newest figure was read, shows "Refreshing…" while the daemon reads,
 * and says so when the daemon could not be asked (the old figures stay).
 */
/** How long "some figures still loading" may stay when no late broadcast comes. */
export const PARTIAL_NOTE_MS = 30_000;

function RefreshRow({ summary, now }: { summary: UsageSummary; now: number }) {
  const [state, setState] = useState<'idle' | 'loading' | 'error' | 'partial'>('idle');
  const newest = summary.providers.reduce((m, p) => Math.max(m, p.asOf ?? 0), 0);
  // A partial answer: the late figures arrive by the `usage-limits` broadcast. The note goes when the
  // store takes a newer summary, or after a short time when none comes (it stayed until the next Refresh).
  useEffect(() => {
    if (state !== 'partial') return;
    const done = () => setState((s) => (s === 'partial' ? 'idle' : s));
    const shown = useUsageLimits.getState().summary;
    const off = useUsageLimits.subscribe((s) => { if (s.summary !== shown) done(); });
    const timer = setTimeout(done, PARTIAL_NOTE_MS);
    return () => { off(); clearTimeout(timer); };
  }, [state]);
  const run = async () => {
    if (state === 'loading') return;
    setState('loading');
    try { const r = await useUsageLimits.getState().refresh(); setState(r.partial ? 'partial' : 'idle'); }
    catch { setState('error'); }
  };
  const text = state === 'loading' ? 'Refreshing…'
    : state === 'error' ? 'Could not refresh. Try again.'
    : newest ? `Updated ${whenLabel(newest, Math.max(now, Date.now()))}${state === 'partial' ? ' · some figures still loading' : ''}` : 'No figures yet';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <span data-testid="usage-updated" aria-live="polite" style={{ flex: 1, minWidth: 0, font: '400 11.5px var(--font-mono)', color: state === 'error' ? 'var(--color-status-red)' : 'var(--color-text-tertiary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{text}</span>
      <button type="button" onClick={() => void run()} disabled={state === 'loading'} aria-busy={state === 'loading'} aria-label="Refresh usage" title="Read the usage figures now"
        style={{ display: 'inline-flex', alignItems: 'center', gap: 6, height: 26, padding: '0 10px', flexShrink: 0, background: 'transparent', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', color: 'var(--color-text-primary)', fontSize: 12.5, fontWeight: 500, cursor: state === 'loading' ? 'default' : 'pointer', opacity: state === 'loading' ? 0.7 : 1 }}>
        <ArrowClockwise size={13} weight="bold" aria-hidden style={{ animation: state === 'loading' ? 'dispatchSpin 0.9s linear infinite' : undefined }} />
        {state === 'loading' ? 'Refreshing' : 'Refresh'}
      </button>
    </div>
  );
}

/** `current` (opened from a thread, 2026-11-07): that thread's account is marked with a "This thread" tab, in its own place. */
export function UsageRings({ summary, now, current, dense }: { summary: UsageSummary | null; now: number; current?: { provider: string; accountId: string } | null; dense?: boolean }) {
  const accounts = useAccounts((s) => s.view);
  // Each time the sheet opens: the accounts, with what each Claude sign-in can do for the figures (W1-H).
  useEffect(() => { void useAccounts.getState().reload(); }, []);
  const accountOf = (m: Pick<RingModel, 'provider' | 'accountId'>): Account | null => {
    const harness = accountProviderOf(m.provider);
    return (harness && accounts?.[harness]?.find((a) => a.id === m.accountId)) || null;
  };
  const emailOf = (m: RingModel): string | null => accountOf(m)?.email || null;
  const accessOf = (m: RingModel): CardAccess | null => {
    if (m.provider !== 'claude-code') return null;
    const a = accountOf(m);
    const u = usageAccessOf(a);
    if (!a || !u) return null;
    const figuresAt = summary?.providers.find((p) => p.provider === m.provider && (p.accountId ?? 'cli') === m.accountId)?.asOf ?? null;
    return { state: u.state, accountId: a.id, label: a.label, isCli: a.isCli, figuresAt, now };
  };
  const isCurrent = (m: RingModel) => !!current && m.provider === current.provider && m.accountId === current.accountId;
  const models = ringModels(summary, now);
  // A refused Claude account that never reported a figure has no ring: it still gets a card, for the note and the next step.
  const missing: RingModel[] = (accounts?.claude ?? [])
    .filter((a) => { const u = usageAccessOf(a); return !!u && u.state !== 'rate-limited' && !models.some((m) => m.provider === 'claude-code' && m.accountId === a.id); })
    .map((a) => ({
      provider: 'claude-code', accountId: a.id, name: (accounts?.claude.length ?? 0) > 1 ? `Claude · ${a.label}` : 'Claude', plan: a.plan,
      main: { type: 'none', label: 'no limit', left: 100, tone: 'green', reset: null, estimate: null, estimateTitle: null },
      rows: [], asOf: '', stale: false, paused: false, credits: 0, creditList: [], useUrl: null, spend: null, creditBalance: null,
    } as RingModel));
  // One fixed order (owner, 2026-11-13): the open thread's account is marked by its tab, never moved to the top.
  const rings = [...models, ...missing];
  if (!summary || (rings.length === 0 && summary.paused.length === 0)) return <div style={{ fontSize: 13, color: 'var(--color-text-tertiary)', padding: '8px 0' }}>No figures reported yet</div>;
  return (
    <div data-testid="usage-rings" style={{ display: 'flex', flexDirection: 'column', gap: dense ? 10 : 16 }}>
      {/* A pause can come before any figure (a paused Codex with no snapshot): its line still shows. */}
      <RefreshRow summary={summary} now={now} />
      {rings.length === 0 && <div style={{ fontSize: 13, color: 'var(--color-text-tertiary)' }}>No figures reported yet</div>}
      {rings.map((m) => (
        <ToolCard key={`${m.provider}|${m.accountId}`} m={m} warn={summary.warnPercent} current={isCurrent(m)} dense={dense} email={emailOf(m)} access={accessOf(m)} />
      ))}
      {summary.paused.map((g) => (
        <div key={g.provider} style={{ fontSize: 12, color: 'var(--color-status-red)', overflowWrap: 'anywhere' }}>{bannerText(g, now)}</div>
      ))}
    </div>
  );
}
