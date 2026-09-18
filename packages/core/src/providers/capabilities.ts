import { HARNESSES } from './catalog.js';
import { getProvider } from './registry.js';

/** Describe what this daemon can run; UI choices and server validation use this together. */
export function harnessCapabilities() {
  return HARNESSES.map(h => {
    if (h.type === 'shell') return { ...h, capabilities: { resume: false, branch: false, permissions: false, telemetry: { structured: false, pty: false } } };
    const provider = getProvider(h.type);
    const structured = !provider.structured.disabledBy || process.env[provider.structured.disabledBy] !== '0';
    const modes = h.modes.filter(mode => mode !== 'pretty' || structured);
    return { ...h, modes, defaultMode: h.defaultMode && modes.includes(h.defaultMode) ? h.defaultMode : modes[0],
      capabilities: {
        resume: h.type === 'claude-code' || h.type === 'codex',
        branch: !!provider.buildBranchCommand,
        permissions: structured,
        telemetry: { structured, pty: provider.telemetry.ptyCapture !== null },
      } };
  });
}
