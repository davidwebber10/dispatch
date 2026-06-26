import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import type { IntegrationsStatus } from '../../api/types';

export function IntegrationsSection() {
  const [s, setS] = useState<IntegrationsStatus | null>(null);
  useEffect(() => { void api.getIntegrationsStatus().then(setS).catch(() => setS({ installed: false, version: null })); }, []);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <span style={{ font: '700 11px var(--font-mono)', letterSpacing: '1.3px', color: 'var(--color-text-secondary)' }}>INTEGRATIONS</span>
      <div style={{ fontSize: 12.5, color: 'var(--color-text-secondary)' }}>
        {s == null ? 'Checking…'
          : s.installed ? `executor ${s.version} — connected. Integrations are shared across Claude & Codex.`
          : 'executor not installed. Install with: npm i -g executor — then it\'s shared across Claude & Codex.'}
      </div>
    </div>
  );
}
