import { describe, it, expect, afterEach } from 'vitest';
import { buildPeerPrompt } from '../../src/overseer/prompts.js';
import { handleRequest } from '../../src/overseer/agency-mcp.js';
import { reportsStatus } from '../../src/sessions/thread-config.js';

// Owner, 2026-11-12: "remove the Needs You / Done calls from normal threads (probably not threads created
// by another thread like Chat or Control Plane) ... the requirement for those tool calls is confusing the
// model". A turn that had to end with report_status put the whole answer in its thinking, called the
// tool, and wrote one closing line: the reader saw no answer. A thread the owner started has neither
// the tool nor the rule; a thread another thread or a role started keeps both.

const CTX = { projectName: 'P', workingDir: '/w', selfLabel: 'T', selfId: 't1', peers: [] };

describe('reportsStatus: which threads keep report_status', () => {
  it('a thread the owner started does not', () => {
    expect(reportsStatus({})).toBe(false);
    expect(reportsStatus(null)).toBe(false);
    expect(reportsStatus({ model: 'opus', transport: 'structured' })).toBe(false);
  });
  it('a coordinator, an agent, a spawned thread, a Chat thread, a role run and a runner do', () => {
    expect(reportsStatus({ role: 'coordinator' })).toBe(true);
    expect(reportsStatus({ role: 'agent' })).toBe(true);
    expect(reportsStatus({ agentType: 'implementer' })).toBe(true);
    expect(reportsStatus({ spawnedBy: 't0', spawnDepth: 1 })).toBe(true);
    expect(reportsStatus({ origin: 'endless' })).toBe(true);
    expect(reportsStatus({ roleRun: 'r1' })).toBe(true);
    expect(reportsStatus({ runner: true })).toBe(true);
  });
});

describe('the peer prompt', () => {
  it('names report_status and its rule by default (threads started by another thread)', () => {
    const p = buildPeerPrompt(CTX);
    expect(p).toMatch(/report_status/);
  });
  it('says nothing about report_status or a closing line for a thread the owner started', () => {
    const p = buildPeerPrompt({ ...CTX, reportStatus: false });
    expect(p).not.toMatch(/report_status/);
    expect(p).not.toMatch(/closing line/i);
    expect(p).toMatch(/watch_thread/); // the other peer tools stay
  });
});

describe('the agency tool list', () => {
  const saved = process.env.DISPATCH_REPORT_STATUS;
  afterEach(() => { if (saved === undefined) delete process.env.DISPATCH_REPORT_STATUS; else process.env.DISPATCH_REPORT_STATUS = saved; });
  const names = async () => ((await handleRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list' } as never)) as any).result.tools.map((t: any) => t.name);

  it('lists report_status by default', async () => {
    delete process.env.DISPATCH_REPORT_STATUS;
    expect(await names()).toContain('report_status');
  });
  it('leaves report_status out when DISPATCH_REPORT_STATUS=0', async () => {
    process.env.DISPATCH_REPORT_STATUS = '0';
    const list = await names();
    expect(list).not.toContain('report_status');
    expect(list).toContain('message_thread');
  });
});
