import { HARNESSES } from './catalog.js';
import { getProvider } from './registry.js';

/**
 * Harnesses that may run as the Overseer COORDINATOR (not just a worker). A small allowlist
 * rather than a derived rule: the requirements (native-tool stripping + a coordinator tool
 * policy + a per-harness memory dir — see coordinator-policy.ts / spawn-model.ts) are met by
 * exactly these two today. Grok and OpenCode are workers only.
 */
const COORDINATOR_CAPABLE_HARNESSES = new Set(['claude-code', 'codex']);

/** Describe what this daemon can run; UI choices and server validation use this together. */
export function harnessCapabilities() {
  return HARNESSES.map(h => {
    if (h.type === 'shell') return { ...h, capabilities: { resume: false, branch: false, permissions: false, telemetry: { structured: false, pty: false }, coordinator: false } };
    const provider = getProvider(h.type);
    const structured = !provider.structured.disabledBy || process.env[provider.structured.disabledBy] !== '0';
    const modes = h.modes.filter(mode => mode !== 'pretty' || structured);
    return { ...h, modes, defaultMode: h.defaultMode && modes.includes(h.defaultMode) ? h.defaultMode : modes[0],
      capabilities: {
        resume: h.type === 'claude-code' || h.type === 'codex',
        branch: !!provider.buildBranchCommand,
        permissions: structured,
        telemetry: { structured, pty: provider.telemetry.ptyCapture !== null },
        coordinator: COORDINATOR_CAPABLE_HARNESSES.has(h.type),
      } };
  });
}
