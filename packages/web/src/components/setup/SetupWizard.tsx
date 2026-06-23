import { useEffect, useState, useCallback } from 'react';
import type { SetupState, ProviderStatus } from '../../api/types';
import { api } from '../../api/client';
import { useSetup } from '../../stores/setup';

type Step = 'agents' | 'mobile' | 'secrets' | 'done';
const ORDER: Step[] = ['agents', 'mobile', 'secrets', 'done'];

const INSTALL: Record<'claude' | 'codex', { label: string; install: string; login: string }> = {
  claude: { label: 'Claude Code', install: 'npm i -g @anthropic-ai/claude-code', login: 'claude' },
  codex: { label: 'Codex', install: 'npm i -g @openai/codex', login: 'codex login' },
};

export function SetupWizard() {
  const forceOpen = useSetup((s) => s.forceOpen);
  const closeForce = useSetup((s) => s.close);
  const [state, setState] = useState<SetupState | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [step, setStep] = useState<Step>('agents');

  useEffect(() => { void api.getSetupState().then(setState).catch(() => setState(null)); }, []);

  const finish = useCallback(async () => { try { await api.completeSetup(); } catch { /* best-effort */ } setDismissed(true); closeForce(); }, [closeForce]);

  const visible = !!state && !dismissed && (state.firstRun || forceOpen);
  if (!visible || !state) return null;

  const idx = ORDER.indexOf(step);
  const next = () => setStep(ORDER[Math.min(idx + 1, ORDER.length - 1)]);
  const back = () => setStep(ORDER[Math.max(idx - 1, 0)]);

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,.6)' }}>
      <div style={{ width: 'min(560px, 94vw)', maxHeight: '88vh', overflowY: 'auto', background: 'var(--color-pane)', border: '1px solid var(--color-border)', borderRadius: 16, padding: 22, boxShadow: '0 24px 60px -12px rgba(0,0,0,.7)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
          <strong style={{ fontSize: 16 }}>Set up Dispatch</strong>
          <button onClick={finish} style={{ background: 'none', border: 'none', color: 'var(--color-text-tertiary)', cursor: 'pointer', fontSize: 13 }}>Skip all</button>
        </div>
        {step === 'agents' && <AgentsStep providers={state.providers} />}
        {step === 'mobile' && <div data-testid="mobile-step">Mobile step (Task 7)</div>}
        {step === 'secrets' && <div data-testid="secrets-step">Secrets step (Task 8)</div>}
        {step === 'done' && <div>You're all set. Reopen this anytime from Settings → Getting started.</div>}
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 20 }}>
          <button onClick={back} disabled={idx === 0} style={btn(false)}>Back</button>
          {step === 'done'
            ? <button onClick={finish} style={btn(true)}>Finish</button>
            : <button onClick={next} style={btn(true)}>Continue</button>}
        </div>
      </div>
    </div>
  );
}

export function btn(primary: boolean): React.CSSProperties {
  return { height: 34, padding: '0 16px', borderRadius: 9, border: '1px solid var(--color-border)', cursor: 'pointer', fontWeight: 600, fontSize: 13, background: primary ? 'var(--color-accent)' : 'transparent', color: primary ? '#08240F' : 'var(--color-text-secondary)' };
}

function AgentsStep({ providers: initial }: { providers: ProviderStatus[] }) {
  const [providers, setProviders] = useState(initial);
  const [checking, setChecking] = useState(false);
  const recheck = async () => { setChecking(true); try { setProviders(await api.recheckProviders()); } catch { /* keep prior */ } setChecking(false); };
  return (
    <div>
      <p style={{ color: 'var(--color-text-secondary)', fontSize: 13, marginTop: 0 }}>Dispatch drives your local Claude Code / Codex CLIs. Install and sign in to the ones you want.</p>
      {providers.map((p) => {
        const meta = INSTALL[p.name];
        const ok = p.installed && p.signedIn === true;
        return (
          <div key={p.name} style={{ border: '1px solid var(--color-border)', borderRadius: 10, padding: 12, marginBottom: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ color: ok ? 'var(--color-accent)' : 'var(--color-status-red)' }}>{ok ? '✓' : '✗'}</span>
              <strong style={{ fontSize: 13.5 }}>{meta.label}</strong>
              <span style={{ fontSize: 12, color: 'var(--color-text-tertiary)' }}>
                {p.installed ? (p.signedIn === true ? 'signed in' : p.signedIn === 'unknown' ? 'installed · sign-in unknown' : 'installed · signed out') : 'not found'}
              </span>
            </div>
            {!ok && (
              <pre style={{ margin: '8px 0 0', font: '400 11.5px var(--font-mono)', background: 'var(--color-elevated)', borderRadius: 8, padding: '8px 10px', whiteSpace: 'pre-wrap' }}>{meta.install}{'\n'}{meta.login}</pre>
            )}
          </div>
        );
      })}
      <button onClick={recheck} disabled={checking} style={btn(false)}>{checking ? 'Checking…' : 'Re-check'}</button>
    </div>
  );
}
