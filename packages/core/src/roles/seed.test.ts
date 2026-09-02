import { describe, expect, it } from 'vitest';
import type { RoleDefinition } from './definition.js';
import { buildSeedMessage } from './seed.js';

const BASE_DEF: RoleDefinition = {
  name: 'rollup-nightly-check',
  dir: '/x',
  project: 'shopify-product-rollup',
  global: false,
  agentType: 'researcher',
  schedule: { type: 'daily', time: '05:30' },
  authority: 'stage',
  wallClockCapMin: 30,
  brief: "Check last night's runs.",
};

const NOW = '2026-09-02T05:30:00.000Z';

describe('buildSeedMessage', () => {
  it('header names the role and includes nowIso + the freshness instruction', () => {
    const msg = buildSeedMessage({ def: BASE_DEF, memory: '', logTail: [], nowIso: NOW });
    expect(msg).toContain(NOW);
    expect(msg).toContain(BASE_DEF.name);
    expect(msg).toContain('verify the world before acting');
    expect(msg).toContain('fetch, check branch/data state');
    expect(msg).toContain('trust nothing remembered');
  });

  it('observe authority text forbids any writes', () => {
    const msg = buildSeedMessage({ def: { ...BASE_DEF, authority: 'observe' }, memory: '', logTail: [], nowIso: NOW });
    expect(msg).toMatch(/report only/i);
    expect(msg).toMatch(/no writes of any kind/i);
  });

  it('stage authority text allows branches/PRs but forbids merge/deploy/main', () => {
    const msg = buildSeedMessage({ def: { ...BASE_DEF, authority: 'stage' }, memory: '', logTail: [], nowIso: NOW });
    expect(msg).toMatch(/non-protected branches/i);
    expect(msg).toMatch(/open PRs/i);
    expect(msg).toMatch(/NEVER merge/);
    expect(msg).toMatch(/push main\/master\/prod/i);
    expect(msg).toMatch(/mutate data/i);
  });

  it('stage-deploy authority text adds explicit staging deploy forms, keeps production forbidden', () => {
    const msg = buildSeedMessage({ def: { ...BASE_DEF, authority: 'stage-deploy' }, memory: '', logTail: [], nowIso: NOW });
    expect(msg).toMatch(/gh workflow run.*environment=staging/i);
    expect(msg).toMatch(/production/i);
    expect(msg).toMatch(/NEVER merge/);
  });

  it('the three authority levels produce distinguishable text from one another', () => {
    const observe = buildSeedMessage({ def: { ...BASE_DEF, authority: 'observe' }, memory: '', logTail: [], nowIso: NOW });
    const stage = buildSeedMessage({ def: { ...BASE_DEF, authority: 'stage' }, memory: '', logTail: [], nowIso: NOW });
    const stageDeploy = buildSeedMessage({ def: { ...BASE_DEF, authority: 'stage-deploy' }, memory: '', logTail: [], nowIso: NOW });
    expect(observe).not.toBe(stage);
    expect(stage).not.toBe(stageDeploy);
    expect(observe).not.toBe(stageDeploy);
  });

  it('includes the brief body verbatim', () => {
    const msg = buildSeedMessage({ def: BASE_DEF, memory: '', logTail: [], nowIso: NOW });
    expect(msg).toContain(BASE_DEF.brief);
  });

  it('omits the Role memory section when memory is empty or whitespace', () => {
    const empty = buildSeedMessage({ def: BASE_DEF, memory: '', logTail: [], nowIso: NOW });
    expect(empty).not.toContain('## Role memory');
    const whitespace = buildSeedMessage({ def: BASE_DEF, memory: '   \n  ', logTail: [], nowIso: NOW });
    expect(whitespace).not.toContain('## Role memory');
  });

  it('includes the Role memory section with content when memory is non-empty', () => {
    const msg = buildSeedMessage({ def: BASE_DEF, memory: 'prior session notes', logTail: [], nowIso: NOW });
    expect(msg).toContain('## Role memory');
    expect(msg).toContain('prior session notes');
  });

  it('omits the Recent run reports section when logTail is empty', () => {
    const msg = buildSeedMessage({ def: BASE_DEF, memory: '', logTail: [], nowIso: NOW });
    expect(msg).not.toContain('## Recent run reports');
  });

  it('includes the Recent run reports section with the raw tail lines when non-empty', () => {
    const lines = ['{"n":1}', '{"n":2}'];
    const msg = buildSeedMessage({ def: BASE_DEF, memory: '', logTail: lines, nowIso: NOW });
    expect(msg).toContain('## Recent run reports');
    for (const line of lines) expect(msg).toContain(line);
  });

  it('always includes the output contract instructing report_status + fenced json outcome block', () => {
    const msg = buildSeedMessage({ def: BASE_DEF, memory: '', logTail: [], nowIso: NOW });
    expect(msg).toMatch(/report_status/);
    expect(msg).toContain('```json');
    expect(msg).toMatch(/"summary"/);
    expect(msg).toMatch(/"links"/);
    expect(msg).toMatch(/proposedBriefChanges/);
    expect(msg).toMatch(/daemon parses/i);
  });

  it('the fenced json example block is actually valid, parseable JSON', () => {
    const msg = buildSeedMessage({ def: BASE_DEF, memory: '', logTail: [], nowIso: NOW });
    const match = /```json\n([\s\S]*?)\n```/.exec(msg);
    expect(match).not.toBeNull();
    const parsed = JSON.parse(match![1]);
    expect(parsed.outcome).toBe('ok');
  });

  it('instructs exactly one fenced json block and to pick one of the three outcome values', () => {
    const msg = buildSeedMessage({ def: BASE_DEF, memory: '', logTail: [], nowIso: NOW });
    expect(msg).toMatch(/exactly one/i);
    expect(msg).toMatch(/"ok"/);
    expect(msg).toMatch(/"attention"/);
    expect(msg).toMatch(/"failed"/);
  });

  // Final-review Finding 2 (Critical): noteTurnOutcome truncates the runner's final message,
  // which can sever the closing ``` fence off the contract block if the message runs long —
  // extractContract then returns null and a genuinely "failed" night silently records as 'ok'.
  // Part (b) of the fix is instructing the runner itself to stay well under any truncation
  // cap and to put the json block LAST, so a truncation (if it ever happens) trims prose, not
  // the contract.
  it('instructs the runner to keep the entire final message under 1500 characters', () => {
    const msg = buildSeedMessage({ def: BASE_DEF, memory: '', logTail: [], nowIso: NOW });
    expect(msg).toMatch(/1500 characters/);
  });

  it('instructs the runner to put the json block at the end of its final message', () => {
    const msg = buildSeedMessage({ def: BASE_DEF, memory: '', logTail: [], nowIso: NOW });
    expect(msg).toMatch(/end of (your|the) final message/i);
  });

  it('is pure: same inputs produce the same output, no Date.now dependency', () => {
    const a = buildSeedMessage({ def: BASE_DEF, memory: 'm', logTail: ['{"n":1}'], nowIso: NOW });
    const b = buildSeedMessage({ def: BASE_DEF, memory: 'm', logTail: ['{"n":1}'], nowIso: NOW });
    expect(a).toBe(b);
  });
});
