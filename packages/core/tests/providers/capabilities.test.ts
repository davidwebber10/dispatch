import { afterEach, describe, expect, it, vi } from 'vitest';
import { harnessCapabilities } from '../../src/providers/capabilities.js';
import { listProviders } from '../../src/providers/registry.js';
import { HARNESSES } from '../../src/providers/catalog.js';
afterEach(() => vi.unstubAllEnvs());
describe('harness capability registry', () => {
  it('has exactly one catalog entry for each registered provider', () => {
    expect(HARNESSES.filter(h => h.provider).map(h => h.type).sort()).toEqual(listProviders().map(p => p.name).sort());
  });
  it('removes disabled structured transports and selects a supported default', () => {
    vi.stubEnv('DISPATCH_CODEX_PRETTY','0'); vi.stubEnv('DISPATCH_OPENCODE_PRETTY','0');
    const entries = harnessCapabilities();
    expect(entries.find(h => h.type === 'codex')).toMatchObject({ modes: ['cli'], defaultMode: 'cli', capabilities: { permissions: false } });
    expect(entries.find(h => h.type === 'opencode')!.modes).toEqual([]);
  });
  it('declares explicit accounting coverage and resume capabilities', () => {
    expect(harnessCapabilities().find(h => h.type === 'grok')).toMatchObject({ capabilities: { telemetry: { pty: false }, resume: false } });
    expect(harnessCapabilities().find(h => h.type === 'claude-code')).toMatchObject({ capabilities: { telemetry: { pty: true }, resume: true } });
  });
  it('flags coordinator capability true only for claude-code and codex', () => {
    const byType = Object.fromEntries(harnessCapabilities().map(h => [h.type, h.capabilities.coordinator]));
    expect(byType['claude-code']).toBe(true);
    expect(byType['codex']).toBe(true);
    expect(byType['grok']).toBe(false);
    expect(byType['opencode']).toBe(false);
    expect(byType['shell']).toBe(false);
  });
});
