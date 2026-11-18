import { useEffect, useMemo } from 'react';
import { PLATFORM_NAME } from '../../lib/hostCopy';
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
  // One row per company system: the systems OS grants (`entitled`) and those its tools name. A system
  // that still needs the person's consent shows its Connect card instead of a row, never "Connected".
  // `os_*` tools (os_list_connections) belong to OS itself, not to a system.
  const systems = useMemo(() => {
    const pending = new Set((state?.needsConsent ?? []).map((c) => c.system));
    const by = new Map<string, number>();
    for (const id of state?.entitled ?? []) by.set(id, 0);
    for (const t of tools?.tools ?? []) {
      const k = t.system ?? 'other';
      if (k === 'os') continue;
      by.set(k, (by.get(k) ?? 0) + 1);
    }
    return [...by.entries()].filter(([k]) => !pending.has(k)).sort(([a], [b]) => a.localeCompare(b));
  }, [tools, state]);
  if (!state?.hosted) return null;
  const down = !state.reachable || tools?.reachable === false;
  return (
    <SettingsGroup title="Company connections" footer={`${PLATFORM_NAME} decides which company systems your threads can use. Ask your administrator to add one.`}>
      {down && (
        <SettingsRow label={`${PLATFORM_NAME} is not reachable`} hint={`Your threads keep working. Company tools come back by themselves when ${PLATFORM_NAME} answers again.`}
          control={<StatusMark tone="yellow">Offline</StatusMark>} />
      )}
      {!down && state.osToolsEnabled && systems.length === 0 && <SettingsRow label="No company systems are connected yet" />}
      {!state.osToolsEnabled && state.reachable && <SettingsRow label="Company tools are turned off for you" />}
      {systems.map(([system, n]) => (
        <SettingsRow key={system} label={systemLabel(system)} hint={n ? `${n} tool${n === 1 ? '' : 's'}` : undefined} control={<StatusMark tone="accent">Connected</StatusMark>} />
      ))}
      {state.needsConsent.map((c) => (
        <div key={c.system} style={{ padding: '8px 12px' }}>
          <ConnectCard label={c.label} connect={c.connectUrl} />
        </div>
      ))}
    </SettingsGroup>
  );
}

/** A system id as a name: `shopify` → `Shopify`. */
function systemLabel(id: string): string {
  return id ? id.charAt(0).toUpperCase() + id.slice(1) : id;
}
