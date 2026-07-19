import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { resumeAdvice } from './cc-sessions.js';

describe('resumeAdvice', () => {
  let home: string;
  let origHome: string | undefined;
  const workDir = '/tmp/proj';

  // Claude Code encodes the workdir by replacing every "/" with "-".
  function writeTranscript(sessionId: string, lines: unknown[]) {
    const dir = path.join(home, '.claude', 'projects', workDir.replace(/\//g, '-'));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n'));
  }

  function assistant(timestamp: string, usage: Record<string, number>) {
    return { type: 'assistant', timestamp, message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }], usage } };
  }

  const BIG = { input_tokens: 20_000, cache_read_input_tokens: 100_000, cache_creation_input_tokens: 4_000 };
  const SMALL = { input_tokens: 500, cache_read_input_tokens: 1_000, cache_creation_input_tokens: 0 };
  const NOW = Date.parse('2026-07-19T12:00:00.000Z');
  const THREE_HOURS_AGO = '2026-07-19T09:00:00.000Z';
  const TEN_MINUTES_AGO = '2026-07-19T11:50:00.000Z';

  beforeEach(() => {
    origHome = process.env.HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-advice-'));
    process.env.HOME = home;
    delete process.env.CLAUDE_CODE_RESUME_THRESHOLD_MINUTES;
    delete process.env.CLAUDE_CODE_RESUME_TOKEN_THRESHOLD;
  });

  afterEach(() => {
    if (origHome === undefined) delete process.env.HOME; else process.env.HOME = origHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('prompts when the session is both old and large', () => {
    writeTranscript('s1', [assistant(THREE_HOURS_AGO, BIG)]);
    const advice = resumeAdvice(workDir, 's1', NOW);
    expect(advice).not.toBeNull();
    expect(advice!.shouldPrompt).toBe(true);
    expect(Math.round(advice!.ageMinutes)).toBe(180);
    expect(advice!.contextTokens).toBe(124_000);
  });

  it('does not prompt when the session is large but recent', () => {
    writeTranscript('s2', [assistant(TEN_MINUTES_AGO, BIG)]);
    expect(resumeAdvice(workDir, 's2', NOW)!.shouldPrompt).toBe(false);
  });

  it('does not prompt when the session is old but small', () => {
    writeTranscript('s3', [assistant(THREE_HOURS_AGO, SMALL)]);
    expect(resumeAdvice(workDir, 's3', NOW)!.shouldPrompt).toBe(false);
  });

  it('honors the CLI threshold env vars', () => {
    writeTranscript('s4', [assistant(TEN_MINUTES_AGO, SMALL)]);
    process.env.CLAUDE_CODE_RESUME_THRESHOLD_MINUTES = '5';
    process.env.CLAUDE_CODE_RESUME_TOKEN_THRESHOLD = '1000';
    expect(resumeAdvice(workDir, 's4', NOW)!.shouldPrompt).toBe(true);
  });

  it('uses the LAST assistant usage, not a sum across turns', () => {
    writeTranscript('s5', [assistant(THREE_HOURS_AGO, BIG), assistant(THREE_HOURS_AGO, SMALL)]);
    expect(resumeAdvice(workDir, 's5', NOW)!.contextTokens).toBe(1_500);
  });

  it('returns null when the transcript is missing', () => {
    expect(resumeAdvice(workDir, 'nope', NOW)).toBeNull();
  });
});
