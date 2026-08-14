import { describe, it, expect } from 'vitest';
import { AGENT_CLI, AGENT_TYPES, TAB_ONLY_TYPES, THREAD_TYPES, isAgentType, isThreadType } from '../../src/providers/agent-types.js';
import { listProviders, getProvider } from '../../src/providers/registry.js';
import { PTY_TYPES } from '../../src/db/terminals.js';
import { PROVIDER_NAMES } from '../../src/setup/detect.js';

/**
 * These are the guards that make the shared list worth having. Adding a provider to the
 * registry and forgetting one of the derived lists used to fail silently — three separate
 * shipped bugs. Now it fails here.
 */
describe('the harness list and the provider registry cannot drift', () => {
  it('every registered provider is in AGENT_TYPES', () => {
    for (const p of listProviders()) {
      expect(AGENT_TYPES, `provider "${p.name}" is registered but missing from AGENT_TYPES`).toContain(p.name);
    }
  });

  it('every AGENT_TYPE resolves to a registered provider', () => {
    for (const t of AGENT_TYPES) {
      expect(() => getProvider(t), `"${t}" is in AGENT_TYPES but has no provider`).not.toThrow();
    }
  });

  it('the two lists are the same size, so neither has a stray entry', () => {
    expect(listProviders()).toHaveLength(AGENT_TYPES.length);
  });

  it('every agent type maps to a CLI binary name', () => {
    for (const t of AGENT_TYPES) {
      expect(AGENT_CLI[t], `"${t}" has no CLI name`).toBeTruthy();
    }
    expect(Object.keys(AGENT_CLI).sort()).toEqual([...AGENT_TYPES].sort());
  });

  it('detection covers exactly the CLIs behind the harnesses', () => {
    expect([...PROVIDER_NAMES].sort()).toEqual(AGENT_TYPES.map((t) => AGENT_CLI[t]).sort());
  });
});

describe('derived lists', () => {
  it('THREAD_TYPES is the agents plus the plain shell', () => {
    expect(THREAD_TYPES).toEqual([...AGENT_TYPES, 'shell']);
  });

  it('the PTY list is the thread list — every one spawns a process', () => {
    expect([...PTY_TYPES].sort()).toEqual([...THREAD_TYPES].sort());
  });

  it('tab-only types spawn nothing and are kept apart', () => {
    for (const t of TAB_ONLY_TYPES) {
      expect(isThreadType(t)).toBe(false);
      expect(isAgentType(t)).toBe(false);
    }
  });
});

describe('the type guards', () => {
  it('treats every harness as an agent', () => {
    for (const t of AGENT_TYPES) expect(isAgentType(t)).toBe(true);
  });

  it('does not treat a plain shell as an agent, but does count it as a thread', () => {
    // The distinction that matters: a shell has no agent process to inject MCP servers,
    // hooks or a system prompt into — which is the ONLY reason to exclude a type.
    expect(isAgentType('shell')).toBe(false);
    expect(isThreadType('shell')).toBe(true);
  });

  it('rejects anything unknown', () => {
    expect(isAgentType('gemini')).toBe(false);
    expect(isThreadType('')).toBe(false);
  });
});
