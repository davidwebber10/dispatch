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

  // Boundary precision: the gate is `>=` on both dimensions, not `>`. Every other test in
  // this file sits far from the boundary (3h/BIG vs. 10m/SMALL), so accidentally flipping
  // either `>=` to `>` would still leave them all green.
  describe('boundary precision (the gate is >=, not >)', () => {
    it('prompts when age is EXACTLY 70 minutes and tokens EXACTLY 100,000', () => {
      const t = NOW - 70 * 60_000;
      writeTranscript('boundary-both', [assistant(new Date(t).toISOString(), { input_tokens: 100_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })]);
      expect(resumeAdvice(workDir, 'boundary-both', NOW)!.shouldPrompt).toBe(true);
    });

    it('does not prompt when age is a hair under 70 minutes (tokens still at the threshold)', () => {
      const t = NOW - (70 * 60_000 - 1);
      writeTranscript('boundary-age-under', [assistant(new Date(t).toISOString(), { input_tokens: 100_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })]);
      expect(resumeAdvice(workDir, 'boundary-age-under', NOW)!.shouldPrompt).toBe(false);
    });

    it('does not prompt when tokens are a hair under 100,000 (age still at the threshold)', () => {
      const t = NOW - 70 * 60_000;
      writeTranscript('boundary-tok-under', [assistant(new Date(t).toISOString(), { input_tokens: 99_999, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })]);
      expect(resumeAdvice(workDir, 'boundary-tok-under', NOW)!.shouldPrompt).toBe(false);
    });
  });

  // The two threshold env vars must be read INDEPENDENTLY. The existing "honors the CLI
  // threshold env vars" test above sets BOTH at once, so a bug that read the SAME var for
  // both thresholds would still pass it.
  describe('threshold env vars are read independently', () => {
    it('honors the age threshold env var alone — the token threshold still uses its 100k default', () => {
      // Aged past a tiny custom age threshold, but nowhere near the real 100k token default.
      writeTranscript('s6', [assistant(TEN_MINUTES_AGO, SMALL)]);
      process.env.CLAUDE_CODE_RESUME_THRESHOLD_MINUTES = '5';
      // CLAUDE_CODE_RESUME_TOKEN_THRESHOLD deliberately left unset.
      // A bug that reused this var for the token threshold too (5) would flip this to true,
      // since SMALL's 1,500 tokens clears 5 easily.
      expect(resumeAdvice(workDir, 's6', NOW)!.shouldPrompt).toBe(false);
    });

    it('honors the token threshold env var alone — the age threshold still uses its 70m default', () => {
      // Well past the tiny custom token threshold, but nowhere near the real 70m age default.
      writeTranscript('s7', [assistant(TEN_MINUTES_AGO, BIG)]);
      process.env.CLAUDE_CODE_RESUME_TOKEN_THRESHOLD = '5';
      // CLAUDE_CODE_RESUME_THRESHOLD_MINUTES deliberately left unset.
      // A bug that reused this var for the age threshold too (5) would flip this to true,
      // since 10 minutes clears an age threshold of 5 easily.
      expect(resumeAdvice(workDir, 's7', NOW)!.shouldPrompt).toBe(false);
    });
  });
});
