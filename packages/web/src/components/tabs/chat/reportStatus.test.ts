import { describe, it, expect } from 'vitest';
import { isReportStatusTool, parseReportStatus, reportStatusKey } from './reportStatus';

describe('isReportStatusTool', () => {
  it('matches the MCP-namespaced tool under any server name, and the bare name', () => {
    expect(isReportStatusTool('mcp__dispatch__report_status')).toBe(true);
    expect(isReportStatusTool('mcp__agency__report_status')).toBe(true);
    expect(isReportStatusTool('report_status')).toBe(true);
  });
  it('does not match other tools', () => {
    expect(isReportStatusTool('mcp__dispatch__message_thread')).toBe(false);
    expect(isReportStatusTool('Bash')).toBe(false);
    expect(isReportStatusTool(undefined)).toBe(false);
    expect(isReportStatusTool('report_status_extra')).toBe(false);
  });
});

describe('parseReportStatus', () => {
  it('pulls the four fields out of pretty JSON', () => {
    const input = JSON.stringify({ state: 'needs_you', summary: 'Found 3 options', ask: 'Which auth flow?' }, null, 2);
    expect(parseReportStatus(input)).toEqual({ state: 'needs_you', summary: 'Found 3 options', ask: 'Which auth flow?', blocker: undefined });
  });

  it('collapses blank/whitespace fields to undefined', () => {
    const input = JSON.stringify({ state: 'done', summary: '   ', ask: '' });
    expect(parseReportStatus(input)).toEqual({ state: 'done', summary: undefined, ask: undefined, blocker: undefined });
  });

  it('returns null for absent / malformed / empty input (caller falls back to the generic row)', () => {
    expect(parseReportStatus(undefined)).toBeNull();
    expect(parseReportStatus('not json {')).toBeNull();
    expect(parseReportStatus('"a string"')).toBeNull();
    expect(parseReportStatus('null')).toBeNull();
    expect(parseReportStatus(JSON.stringify({}))).toBeNull();
    expect(parseReportStatus(JSON.stringify({ summary: '   ' }))).toBeNull(); // nothing usable
  });

  it('keeps a blocker for a blocked turn', () => {
    const input = JSON.stringify({ state: 'blocked', blocker: 'waiting on the deploy' });
    expect(parseReportStatus(input)).toEqual({ state: 'blocked', summary: undefined, ask: undefined, blocker: 'waiting on the deploy' });
  });
});

describe('reportStatusKey', () => {
  it('is the same for the compact and the pretty-printed form of one call', () => {
    const a = reportStatusKey(JSON.stringify({ state: 'done', summary: 'shipped', ask: '  ' }));
    const b = reportStatusKey(JSON.stringify({ summary: 'shipped', state: 'done' }, null, 2));
    expect(a).toBeTruthy();
    expect(a).toBe(b);
  });
  it('differs when the content differs, and is null for nothing to show', () => {
    expect(reportStatusKey(JSON.stringify({ state: 'done', summary: 'a' }))).not.toBe(reportStatusKey(JSON.stringify({ state: 'done', summary: 'b' })));
    expect(reportStatusKey(JSON.stringify({ state: 'done', summary: 'a' }))).not.toBe(reportStatusKey(JSON.stringify({ state: 'blocked', summary: 'a' })));
    expect(reportStatusKey('not json')).toBeNull();
    expect(reportStatusKey(undefined)).toBeNull();
  });
});
