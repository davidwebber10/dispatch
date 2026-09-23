// The inline control-plane setup card — spec: when ensureForProject peeks a project and
// finds no live coordinator (store's `setupNeeded`), the Overseer shows this instead of
// silently auto-creating one, so the user picks the harness the coordinator ITSELF runs on
// (Phase 2), the worker harness it spawns agents with, and its own model, before anything
// starts running.
//
// Self-contained: reads the store itself (no props), so both ConversationStream (desktop +
// mobile — they share the one component, see Stream.tsx's doc comment) mount it bare.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { HarnessStrip } from '../../common/HarnessStrip';
import { SearchSelect } from '../../common/SearchSelect';
import { Spinner } from '../../common/Spinner';
import { api, type HarnessCapability } from '../../../api/client';
import type { ProviderName, ProviderStatus } from '../../../api/types';
import { HARNESSES } from '../../../lib/harnesses';
import { useIsMobile } from '../../../hooks/useIsMobile';
import { useProjects } from '../../../stores/projects';
import { useOverseer } from '../store';

const ACCENT = 'var(--color-accent)';
const GLOW = '0 0 6px 1px rgba(62,207,106,.4)';
const BORDER = '#2C2C32';

/**
 * The strip renders catalog ids (`claude`/`codex`/`grok`/`opencode`), but the daemon (and
 * `setupSelection.workerHarness`) wants the wire `type` sent to POST /terminals
 * (`claude-code`/`codex`/`grok`/`opencode`). Map on selection; the strip's own `value` is
 * derived by the reverse lookup below.
 */
const WIRE: Record<string, string> = { claude: 'claude-code', codex: 'codex', grok: 'grok', opencode: 'opencode' };
const CATALOG_ID: Record<string, string> = Object.fromEntries(Object.entries(WIRE).map(([id, wire]) => [wire, id]));

// The pills the strip always offers — every agent harness, never the plain shell (a
// coordinator's workers are agents; a shell has nothing for it to hand off to).
const AGENT_HARNESSES = HARNESSES.filter((h) => h.id !== 'terminal').map((h) => ({ id: h.id, label: h.label }));

// Seed for `enabled` before the real capability probe answers — every pill selectable (see
// that effect's doc comment), with `coordinator` guessed from today's fixed allowlist
// (providers/capabilities.ts's COORDINATOR_CAPABLE_HARNESSES) so the Coordinator strip never
// flashes all four harnesses before narrowing to Claude + Codex.
const SEED_CAPABILITIES: HarnessCapability[] = HARNESSES.map((h) => ({
  ...h,
  capabilities: { resume: false, branch: false, permissions: false, telemetry: { structured: false, pty: false }, coordinator: h.id === 'claude' || h.id === 'codex' },
}));

// Per-coordinator-harness default model, applied when the user switches the Coordinator strip:
// Claude keeps its historical "sonnet" pin; a harness absent here (e.g. Codex) falls back to
// "" (SearchSelect's "Default"), which ensureOverseerCoordinator's server side reads as "let
// the daemon pick its own default" (falsy `opts.model` is omitted — see ensureCoordinator).
const COORDINATOR_DEFAULT_MODEL: Record<string, string> = { claude: 'sonnet' };

export function ControlPlaneSetupCard(): JSX.Element {
  const isMobile = useIsMobile();
  const setupSelection = useOverseer((s) => s.setupSelection);
  const setSetupSelection = useOverseer((s) => s.setSetupSelection);
  const coordinatorProject = useOverseer((s) => s.coordinatorProject);
  const startCoordinator = useOverseer((s) => s.startCoordinator);
  const ensuring = useOverseer((s) => s.ensuring);

  // Availability (CLI installed / enabled on this box) + coordinator eligibility: seed with
  // the full catalog (every pill selectable) so a slow probe never blocks the card, then
  // replace with the daemon's actual capability list once it answers — mirrors NewThreadModal's
  // seed-then-replace.
  const [enabled, setEnabled] = useState<HarnessCapability[]>(SEED_CAPABILITIES);
  useEffect(() => {
    let live = true;
    api.getHarnessCapabilities?.().then((items) => {
      if (!live) return;
      setEnabled(items.filter((h) => h.modes.length > 0));
    }).catch(() => {});
    return () => { live = false; };
  }, []);

  // Provider install state (CLI on PATH), same seam NewThreadModal reads — `null` until the
  // probe answers, so a slow check never dims a harness that just hasn't heard back yet.
  const [providers, setProviders] = useState<ProviderStatus[] | null>(null);
  useEffect(() => {
    let live = true;
    api.recheckProviders?.().then((items) => { if (live) setProviders(items); }).catch(() => {});
    return () => { live = false; };
  }, []);
  const providerFor = useCallback((id: string): ProviderName | null => HARNESSES.find((h) => h.id === id)?.provider ?? null, []);
  const isAvailable = useCallback((id: string) => {
    if (!enabled.some((h) => h.id === id)) return false;
    const provider = providerFor(id);
    if (!provider) return true;
    return providers?.find((p) => p.name === provider)?.installed !== false;
  }, [enabled, providers, providerFor]);

  const selectedCatalogId = CATALOG_ID[setupSelection.workerHarness] ?? 'claude';

  // The harnesses eligible to BE the coordinator (Claude + Codex today) — narrower than
  // AGENT_HARNESSES (the Workers strip's full agent list): grok/opencode are workers only,
  // so they're filtered OUT entirely here rather than merely dimmed.
  const coordinatorHarnesses = useMemo(
    () => enabled.filter((h) => h.capabilities.coordinator).map((h) => ({ id: h.id, label: h.label })),
    [enabled],
  );
  const selectedCoordinatorCatalogId = CATALOG_ID[setupSelection.coordinatorHarness] ?? 'claude';
  const modelOptions = useMemo(() => {
    const models = HARNESSES.find((h) => h.id === selectedCoordinatorCatalogId)?.models ?? [];
    return models.map((o) => ({ value: o.model ?? '', label: o.label }));
  }, [selectedCoordinatorCatalogId]);

  const sessionId = coordinatorProject ?? useProjects.getState().activeId;

  return (
    <div
      style={{
        background: 'var(--color-elevated)',
        border: `1px solid ${BORDER}`,
        borderRadius: 12,
        padding: isMobile ? 16 : 20,
        display: 'flex',
        flexDirection: 'column',
        gap: 16,
      }}
    >
      <div>
        <div style={{ fontSize: isMobile ? 16 : 15, fontWeight: 600, color: 'var(--color-text-primary)' }}>
          I'm Control Plane — the coordinator for this project.
        </div>
        <div style={{ marginTop: 4, fontSize: isMobile ? 13 : 12.5, lineHeight: 1.5, color: 'var(--color-text-secondary)' }}>
          Pick the agents I run, then fire the first directive — or just start.
        </div>
      </div>

      <div data-testid="workers-strip" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <span
          style={{
            fontSize: isMobile ? 12.5 : 11,
            fontWeight: 600,
            letterSpacing: '.04em',
            textTransform: 'uppercase',
            color: 'var(--color-text-tertiary)',
          }}
        >
          Workers
        </span>
        <HarnessStrip
          harnesses={AGENT_HARNESSES}
          value={selectedCatalogId}
          onSelect={(id) => setSetupSelection({ workerHarness: WIRE[id] ?? id })}
          isAvailable={isAvailable}
          mobile={isMobile}
        />
      </div>

      <div data-testid="coordinator-strip" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <span
          style={{
            fontSize: isMobile ? 12.5 : 11,
            fontWeight: 600,
            letterSpacing: '.04em',
            textTransform: 'uppercase',
            color: 'var(--color-text-tertiary)',
          }}
        >
          Coordinator
        </span>
        <HarnessStrip
          harnesses={coordinatorHarnesses}
          value={selectedCoordinatorCatalogId}
          onSelect={(id) => {
            const wire = WIRE[id] ?? id;
            setSetupSelection({ coordinatorHarness: wire, model: COORDINATOR_DEFAULT_MODEL[id] ?? '' });
          }}
          isAvailable={isAvailable}
          mobile={isMobile}
        />
      </div>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <span style={{ fontSize: isMobile ? 14 : 13, color: 'var(--color-text-secondary)' }}>Coordinator model</span>
        <div style={{ width: isMobile ? 180 : 160 }}>
          <SearchSelect
            ariaLabel="Coordinator model"
            size={isMobile ? 'lg' : 'md'}
            value={setupSelection.model}
            onChange={(v) => setSetupSelection({ model: v })}
            options={modelOptions}
          />
        </div>
      </div>

      <button
        type="button"
        disabled={ensuring || !sessionId}
        onClick={() => { if (sessionId) void startCoordinator(sessionId); }}
        style={{
          height: isMobile ? 44 : 38,
          border: 'none',
          borderRadius: 10,
          background: ACCENT,
          color: '#08240F',
          fontWeight: 600,
          fontSize: isMobile ? 14.5 : 13.5,
          cursor: ensuring || !sessionId ? 'default' : 'pointer',
          opacity: ensuring || !sessionId ? 0.7 : 1,
          boxShadow: GLOW,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 8,
        }}
      >
        {ensuring ? (<><Spinner size={13} /> Starting…</>) : 'Start'}
      </button>
    </div>
  );
}
