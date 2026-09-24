import { describe, expect, it } from 'vitest';
import { disallowedToolsFor } from './service.js';
import { COORDINATOR_DISALLOWED_TOOLS } from '../overseer/coordinator-policy.js';
import { ROLE_DISALLOWED_TOOLS } from '../roles/role-policy.js';

// Which tools a structured Claude thread has stripped from its toolset at spawn (--disallowedTools).
// Stripping is the defense in depth under the membrane policy: the model never sees the tool.
describe('disallowedToolsFor', () => {
  it('strips native orchestration from a coordinator (unchanged)', () => {
    expect(disallowedToolsFor({ role: 'coordinator' })).toEqual(COORDINATOR_DISALLOWED_TOOLS);
  });

  it('strips native orchestration and the Dispatch delegation and steering tools from a role run', () => {
    expect(disallowedToolsFor({ role: 'agent', roleAuthority: 'observe' })).toEqual(ROLE_DISALLOWED_TOOLS);
    expect(disallowedToolsFor({ role: 'agent', roleAuthority: 'stage' })).toEqual(ROLE_DISALLOWED_TOOLS);
    expect(disallowedToolsFor({ role: 'agent', roleAuthority: 'stage' })).toEqual(
      expect.arrayContaining(['Agent', 'Task', 'Workflow', 'mcp__dispatch__spawn_agent']),
    );
  });

  it('strips nothing from a plain thread or a coordinator-spawned agent', () => {
    expect(disallowedToolsFor({})).toBeUndefined();
    expect(disallowedToolsFor({ role: 'agent', agentType: 'implementer' })).toBeUndefined();
  });
});
