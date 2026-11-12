import { useEffect, useMemo } from 'react';
import { useOsConnections } from '../../stores/osConnections';
import { SettingsGroup, SettingsRow, StatusMark } from '../settings/ui';
import { ConnectCard } from './ConnectCard';

/**
 * Company connections (hosted box only): the systems POLYWOOD OS connects for this person, read-only,
 * and a Connect card for each one that still needs the person's consent. Adding an own MCP server
 * stays in Settings > Integrations (developer profile). A local daemon shows nothing.
 */
export function CompanyConnections() {
  const state = useOsConnections((s) => s.state);
  const tools = useOsConnections((s) => s.tools);
  useEffect(() => { void useOsConnections.getState().load(); }, []);
  const systems = useMemo(() => {
    const by = new Map<string, number>();
    for (const t of tools?.tools ?? []) {
      const k = t.system ?? 'other';
      by.set(k, (by.get(k) ?? 0) + 1);
    }
    return [...by.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [tools]);
  if (!state?.hosted) return null;
  const down = !state.reachable || tools?.reachable === false;
  return (
    <SettingsGroup title="Company connections" footer="POLYWOOD OS decides which company systems your threads can use. Ask your administrator to add one.">
      {down && (
        <SettingsRow label="POLYWOOD OS is not reachable" hint="Your threads keep working. Company tools come back by themselves when POLYWOOD OS answers again."
          control={<StatusMark tone="yellow">Offline</StatusMark>} />
      )}
      {!down && state.osToolsEnabled && systems.length === 0 && <SettingsRow label="No company systems are connected yet" />}
      {!state.osToolsEnabled && state.reachable && <SettingsRow label="Company tools are turned off for you" />}
      {systems.map(([system, n]) => (
        <SettingsRow key={system} label={system} hint={`${n} tool${n === 1 ? '' : 's'}`} control={<StatusMark tone="accent">Connected</StatusMark>} />
      ))}
      {state.needsConsent.map((c) => (
        <div key={c.system} style={{ padding: '8px 12px' }}>
          <ConnectCard label={c.label} connect={c.connectUrl} />
        </div>
      ))}
    </SettingsGroup>
  );
}
