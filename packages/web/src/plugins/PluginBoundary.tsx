import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * Plugins (docs/superpowers/specs/2026-11-07-plugins-design.md, section 2.3): every plugin render
 * sits inside this, so a plugin that throws shows a card with its name and the error, and the
 * rest of the screen stays. The boundary resets when the plugin reloads (`resetKey` changes).
 */
export class PluginBoundary extends Component<{ plugin: string; resetKey?: unknown; children: ReactNode }, { error: Error | null; key: unknown }> {
  state: { error: Error | null; key: unknown } = { error: null, key: undefined };

  static getDerivedStateFromProps(props: { resetKey?: unknown }, state: { error: Error | null; key: unknown }) {
    return props.resetKey !== state.key ? { error: null, key: props.resetKey } : null;
  }

  static getDerivedStateFromError(error: Error) { return { error }; }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[plugin ${this.props.plugin}]`, error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div role="alert" style={{ margin: 12, padding: '12px 14px', borderRadius: 'var(--radius-lg)', border: '1px solid var(--color-status-red)', background: 'rgba(255,80,80,0.08)', color: 'var(--color-text-primary)', fontSize: 13 }}>
        <div style={{ fontWeight: 600 }}>The plugin "{this.props.plugin}" failed</div>
        <pre style={{ margin: '6px 0 0', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', font: '12px/1.5 var(--font-mono)', color: 'var(--color-text-secondary)' }}>{this.state.error.message}</pre>
        <div style={{ marginTop: 6, fontSize: 11.5, color: 'var(--color-text-tertiary)' }}>Fix the plugin's file and save: the app reloads it. Settings → Plugins can disable it.</div>
      </div>
    );
  }
}
