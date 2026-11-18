import { Component, useState, type CSSProperties, type ErrorInfo, type ReactNode } from 'react';
import { WarningCircle } from '@phosphor-icons/react';
import { copyText } from '../../lib/clipboard';
import { fontVar } from '../../lib/fontSize';

/**
 * A render error in one part of the app must not blank the rest of it (engineering program
 * 2026-11-09, W1-G). The root boundary sits in main.tsx; one boundary sits around each view in
 * App.tsx and around the phone leaf. The boundary only logs: it makes no network call.
 *
 * `scope` names the part ("root", "settings view") in the log and in the copied details.
 * `fallback` replaces the default card. `reset` renders the children again.
 */
export interface ErrorFallbackProps { error: Error; reset(): void }

interface Props {
  scope: string;
  fallback?: (p: ErrorFallbackProps) => ReactNode;
  children?: ReactNode;
}

interface State { error: Error | null; componentStack: string }

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, componentStack: '' };

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[error boundary: ${this.props.scope}]`, error, info.componentStack);
    this.setState({ componentStack: info.componentStack ?? '' });
  }

  reset = () => this.setState({ error: null, componentStack: '' });

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (this.props.fallback) return this.props.fallback({ error, reset: this.reset });
    return <DefaultFallback scope={this.props.scope} error={error} componentStack={this.state.componentStack} reset={this.reset} />;
  }
}

/** The text that "Copy details" puts on the clipboard. No thread content: only the error itself. */
export function errorDetails(scope: string, error: Error, componentStack: string): string {
  return [
    `Dispatch error in: ${scope}`,
    `Message: ${error.message}`,
    `Page: ${typeof location !== 'undefined' ? location.pathname : ''}`,
    '',
    error.stack ?? '(no stack)',
    componentStack ? `\nComponent stack:${componentStack}` : '',
  ].join('\n');
}

const button: CSSProperties = {
  height: 34, padding: '0 14px', background: 'var(--color-elevated)', border: '1px solid var(--color-border-strong)',
  borderRadius: 'var(--radius-md)', color: 'var(--color-text-primary)', fontSize: fontVar(13), cursor: 'pointer',
};

function DefaultFallback({ scope, error, componentStack, reset }: { scope: string; error: Error; componentStack: string; reset(): void }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void copyText(errorDetails(scope, error, componentStack)).then(() => setCopied(true)).catch(() => {});
  };
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 1, width: '100%', height: '100%', minHeight: 180, padding: 16, boxSizing: 'border-box', background: 'var(--color-base)' }}>
      <div role="alert" style={{ width: 'min(440px, 100%)', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, textAlign: 'center', color: 'var(--color-text-primary)' }}>
        <WarningCircle size={32} weight="regular" color="var(--color-status-red)" aria-hidden />
        <div style={{ fontSize: fontVar(15), fontWeight: 600 }}>This part of Dispatch stopped because of an error.</div>
        <pre style={{ margin: 0, maxWidth: '100%', maxHeight: 96, overflow: 'auto', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', font: `${fontVar(12)}/1.5 var(--font-mono)`, color: 'var(--color-text-secondary)' }}>{error.message}</pre>
        <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: 8, marginTop: 4 }}>
          <button type="button" onClick={() => window.location.reload()} style={{ ...button, background: 'var(--color-accent)', border: 'none', color: 'var(--color-on-accent)', fontWeight: 600 }}>Reload</button>
          <button type="button" onClick={reset} style={button}>Try again</button>
          <button type="button" onClick={copy} aria-label="Copy details" style={button}>{copied ? 'Copied' : 'Copy details'}</button>
        </div>
      </div>
    </div>
  );
}
