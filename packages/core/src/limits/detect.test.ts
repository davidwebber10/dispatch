import { describe, it, expect } from 'vitest';
import { parseResetTime, detectClaudeLimit, detectCodexLimit, detectBannerLimit, pauseLabel } from './detect.js';

// 2026-10-24 04:31Z is 00:31 in Indianapolis (EDT, UTC-4): the Returns thread's real stop.
const NOW = Date.UTC(2026, 9, 24, 4, 31);
const ZONE = 'America/Indianapolis';
const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

describe('parseResetTime', () => {
  it('reads a time and zone: "resets 1:10am (America/Indianapolis)"', () => {
    expect(iso(parseResetTime('resets 1:10am (America/Indianapolis)', NOW)?.at ?? null)).toBe('2026-10-24T05:10:00.000Z');
  });
  it('a time said at 11 PM rolls to the next day', () => {
    const lateNow = Date.UTC(2026, 9, 24, 3, 0); // 23:00 Oct 23 local
    expect(iso(parseResetTime('resets 1:10am (America/Indianapolis)', lateNow)?.at ?? null)).toBe('2026-10-24T05:10:00.000Z');
  });
  it('a time already past today means tomorrow', () => {
    const morning = Date.UTC(2026, 9, 24, 12, 0); // 08:00 local
    expect(iso(parseResetTime('resets 1:10am (America/Indianapolis)', morning)?.at ?? null)).toBe('2026-10-25T05:10:00.000Z');
  });
  it('reads an hour-only time: "resets 3pm"', () => {
    expect(iso(parseResetTime('resets 3pm (America/Indianapolis)', NOW)?.at ?? null)).toBe('2026-10-24T19:00:00.000Z');
  });
  it('reads a date: "resets Oct 30, 9am"', () => {
    expect(iso(parseResetTime('resets Oct 30, 9am (America/Indianapolis)', NOW)?.at ?? null)).toBe('2026-10-30T13:00:00.000Z');
  });
  it('reads a weekday: "resets Mon 9:00am" (next Monday)', () => {
    expect(iso(parseResetTime('resets Mon 9:00am (America/Indianapolis)', NOW)?.at ?? null)).toBe('2026-10-26T13:00:00.000Z');
  });
  it('reads "try again in 2 hours 5 minutes"', () => {
    expect(iso(parseResetTime('try again in 2 hours 5 minutes', NOW)?.at ?? null)).toBe('2026-10-24T06:36:00.000Z');
  });
  it('reads "try again at Oct 29th, 2026 9:00 AM"', () => {
    expect(parseResetTime('try again at Oct 29th, 2026 9:00 AM (America/Indianapolis)', NOW)?.at).toBe(Date.UTC(2026, 9, 29, 13, 0));
  });
  it('returns null when there is no time', () => {
    expect(parseResetTime('You have hit your limit', NOW)).toBeNull();
  });
});

const sessionText = "You've hit your session limit · resets 1:10am (America/Indianapolis)";

describe('detectClaudeLimit', () => {
  it('reads the real synthetic assistant frame: structured reset wins, kind from rateLimitType', () => {
    const frame = {
      type: 'assistant', apiError: 'usage_limit_reached', isApiErrorMessage: true,
      quotaLimits: { status: 'rejected', resetsAt: 1792818600, rateLimitType: 'five_hour' },
      message: { model: '<synthetic>', content: [{ type: 'text', text: sessionText }] },
    };
    const l = detectClaudeLimit(frame, NOW)!;
    expect(l.kind).toBe('session');
    expect(iso(l.resetsAt)).toBe('2026-10-24T05:10:00.000Z');
    expect(l.message).toBe(sessionText);
  });
  it('a weekly limit by rateLimitType seven_day', () => {
    const frame = { type: 'assistant', apiError: 'usage_limit_reached', quotaLimits: { resetsAt: 1793000000, rateLimitType: 'seven_day' },
      message: { content: [{ type: 'text', text: "You've hit your weekly limit · resets Oct 30, 9am (America/Indianapolis)" }] } };
    expect(detectClaudeLimit(frame, NOW)).toMatchObject({ kind: 'weekly', resetsAt: 1793000000 * 1000 });
  });
  it('an error result with the session text only: kind and time from the text', () => {
    const l = detectClaudeLimit({ type: 'result', subtype: 'success', is_error: true, result: sessionText }, NOW)!;
    expect(l.kind).toBe('session');
    expect(iso(l.resetsAt)).toBe('2026-10-24T05:10:00.000Z');
  });
  it('weekly and Opus-weekly texts are weekly', () => {
    expect(detectClaudeLimit({ type: 'result', is_error: true, result: "You've hit your weekly limit · resets Oct 30, 9am (America/Indianapolis)" }, NOW)?.kind).toBe('weekly');
    expect(detectClaudeLimit({ type: 'result', is_error: true, result: "You've hit your Opus weekly limit · resets Oct 30, 9am (America/Indianapolis)" }, NOW)?.kind).toBe('weekly');
  });
  it('a plain usage limit is kind usage; an unparsable time gives resetsAt null', () => {
    const l = detectClaudeLimit({ type: 'result', is_error: true, result: "You've hit your usage limit" }, NOW)!;
    expect(l).toMatchObject({ kind: 'usage', resetsAt: null });
  });
  it('a rejected rate_limit_event carries the reset', () => {
    const l = detectClaudeLimit({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1792818600, rateLimitType: 'five_hour' } }, NOW)!;
    expect(l).toMatchObject({ kind: 'session', resetsAt: 1792818600 * 1000 });
  });
  it('a rejected rate_limit_event that is using overage, or has a fallback, is not a stop', () => {
    expect(detectClaudeLimit({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1792818600, isUsingOverage: true } }, NOW)).toBeNull();
    expect(detectClaudeLimit({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1792818600, unifiedRateLimitFallbackAvailable: true } }, NOW)).toBeNull();
  });
  it('an allowed rate_limit_event, a normal result, and ordinary prose are not limits', () => {
    expect(detectClaudeLimit({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', resetsAt: 1792818600 } }, NOW)).toBeNull();
    expect(detectClaudeLimit({ type: 'result', is_error: false, result: 'Done.' }, NOW)).toBeNull();
    expect(detectClaudeLimit({ type: 'assistant', message: { content: [{ type: 'text', text: sessionText }] } }, NOW)).toBeNull();
    expect(detectClaudeLimit({ type: 'result', is_error: true, result: 'Tests failed' }, NOW)).toBeNull();
  });
});

describe('detectCodexLimit', () => {
  it('usageLimitExceeded with "try again in" text', () => {
    const l = detectCodexLimit({ message: "You've hit your usage limit. Try again in 2 hours 5 minutes.", codexErrorInfo: 'usageLimitExceeded' }, NOW)!;
    expect(l.kind).toBe('usage');
    expect(iso(l.resetsAt)).toBe('2026-10-24T06:36:00.000Z');
  });
  it('a weekly wording is weekly', () => {
    expect(detectCodexLimit({ message: "You've hit your weekly usage limit. Try again at Oct 29th, 2026 9:00 AM.", codexErrorInfo: 'usageLimitExceeded' }, NOW)?.kind).toBe('weekly');
  });
  it('rateLimitExceeded without a time parks with null reset', () => {
    expect(detectCodexLimit({ message: 'Rate limit reached', codexErrorInfo: 'rateLimitExceeded' }, NOW)).toMatchObject({ kind: 'usage', resetsAt: null });
  });
  it('another error is not a limit', () => {
    expect(detectCodexLimit({ message: 'context window exceeded', codexErrorInfo: 'contextWindowExceeded' }, NOW)).toBeNull();
    expect(detectCodexLimit({ message: 'boom' }, NOW)).toBeNull();
  });
});

describe('detectBannerLimit (CLI threads)', () => {
  it('finds the Claude banner through screen codes', () => {
    const out = `\x1b[31m  ⎿  You've hit your session limit · resets 1:10am (America/Indianapolis)\x1b[0m\r\n`;
    expect(detectBannerLimit(out, NOW)).toMatchObject({ kind: 'session' });
  });
  it('needs the exact shape: bare prose about a limit is ignored', () => {
    expect(detectBannerLimit('the user may hit their session limit someday', NOW)).toBeNull();
  });
});

describe('pauseLabel', () => {
  it('same-day time, kind named', () => {
    expect(pauseLabel('session', Date.UTC(2026, 9, 24, 5, 10), NOW, ZONE)).toBe('Paused: session limit, resumes 1:10 AM');
  });
  it('a later day shows the weekday', () => {
    expect(pauseLabel('weekly', Date.UTC(2026, 9, 26, 13, 0), NOW, ZONE)).toBe('Paused: weekly limit, resumes Mon 9:00 AM');
  });
  it('unknown reset names the fallback', () => {
    expect(pauseLabel('usage', null, NOW, ZONE, 30 * 60_000)).toBe('Paused: usage limit, reset time unknown, retrying in 30 minutes');
  });
});

describe('named limits: Fable, Opus, Sonnet', () => {
  const FRI = Date.UTC(2026, 9, 30, 17, 41); // Fri 1:41 PM Indianapolis (EDT)
  const frame = (type: string, text: string) => ({
    type: 'assistant', apiError: 'usage_limit_reached', isApiErrorMessage: true,
    quotaLimits: { status: 'rejected', resetsAt: FRI / 1000, rateLimitType: type },
    message: { model: '<synthetic>', content: [{ type: 'text', text }] },
  });
  it('structured rateLimitType picks the kind', () => {
    expect(detectClaudeLimit(frame('seven_day_overage_included', "You've hit your Fable limit · resets Fri 1:41 PM"), NOW)).toMatchObject({ kind: 'fable', resetsAt: FRI });
    expect(detectClaudeLimit(frame('seven_day_opus', "You've hit your Opus limit"), NOW)?.kind).toBe('opus');
    expect(detectClaudeLimit(frame('seven_day_sonnet', "You've hit your Sonnet limit"), NOW)?.kind).toBe('sonnet');
    expect(detectClaudeLimit(frame('seven_day', "You've hit your weekly limit"), NOW)?.kind).toBe('weekly');
    expect(detectClaudeLimit(frame('overage', "You've hit your usage credit limit"), NOW)?.kind).toBe('usage');
  });
  it('a rejected rate_limit_event of seven_day_overage_included is fable', () => {
    expect(detectClaudeLimit({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: FRI / 1000, rateLimitType: 'seven_day_overage_included' } }, NOW)).toMatchObject({ kind: 'fable', resetsAt: FRI });
  });
  it('an error result with only the text', () => {
    expect(detectClaudeLimit({ type: 'result', is_error: true, result: "You've hit your Fable limit · resets Oct 30, 1:41pm (America/Indianapolis)" }, NOW)).toMatchObject({ kind: 'fable', resetsAt: Date.UTC(2026, 9, 30, 17, 41) });
    expect(detectClaudeLimit({ type: 'result', is_error: true, result: "You've reached your Fable limit. Fable 5 requires usage credits. Switch to another model to continue." }, NOW)).toMatchObject({ kind: 'fable', resetsAt: null });
    expect(detectClaudeLimit({ type: 'result', is_error: true, result: 'Fable limit reached' }, NOW)?.kind).toBe('fable');
    expect(detectClaudeLimit({ type: 'result', is_error: true, result: 'Sonnet limit reached' }, NOW)?.kind).toBe('sonnet');
  });
  it('the label names the model', () => {
    expect(pauseLabel('fable', FRI, FRI - 3 * 86_400_000, ZONE)).toBe('Paused: Fable limit, resumes Fri 1:41 PM');
    expect(pauseLabel('opus', null, NOW, ZONE, 6 * 3_600_000)).toBe('Paused: Opus limit, reset time unknown, retrying in 6 hours');
  });
  it('the CLI banner: hit or reached, with or without a time', () => {
    expect(detectBannerLimit("  ⎿  You've hit your Fable limit · resets Fri 1:41 PM\r\n", NOW)).toMatchObject({ kind: 'fable' });
    expect(detectBannerLimit("You've reached your Fable limit. Switch to another model to continue.\r\n", NOW)).toMatchObject({ kind: 'fable', resetsAt: null });
    expect(detectBannerLimit("You've hit your session limit\r\n", NOW)).toMatchObject({ kind: 'session', resetsAt: null });
  });
  it('the CLI banner reads a year and "Mon at 9am" resets', () => {
    expect(detectBannerLimit("You've hit your weekly limit · resets Oct 30, 2026 9am (America/Indianapolis)\r\n", NOW)?.resetsAt).toBe(Date.UTC(2026, 9, 30, 13, 0));
    expect(detectBannerLimit("You've hit your weekly limit · resets Mon at 9am (America/Indianapolis)\r\n", NOW)?.resetsAt).toBe(Date.UTC(2026, 9, 26, 13, 0));
  });
});


// --- Codex CLI (terminal) and Grok -------------------------------------------------------------
// The Codex wording is taken from the strings inside the installed `codex` 0.166.0 binary
// (the "You've hit your usage limit..." templates and "try again at <time>"). The Grok wording
// is a real stop in ~/.grok/logs (subscription:free-usage-exhausted) and its ACP session file.
import { detectCodexBannerLimit, textAfterCodexBanner, textAfterBanner, detectGrokLimit } from './detect.js';

describe('detectCodexBannerLimit (Codex CLI threads)', () => {
  const plus = "■ You've hit your usage limit. Upgrade to Plus to continue using Codex (https://chatgpt.com/explore/plus), or try again at 9:15 AM.";
  it('reads the reset time from "try again at <time>"', () => {
    const l = detectCodexBannerLimit(plus, NOW)!;
    expect(l.kind).toBe('usage');
    expect(l.message).toContain("You've hit your usage limit");
    // 9:15 AM on the next local clock reading; the time is local, so compare against the parser.
    expect(l.resetsAt).toBe(parseResetTime('try again at 9:15 AM', NOW)!.at);
  });
  it('reads a dated reset and the Pro wording', () => {
    const t = "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/settings/usage to purchase more credits or try again at Oct 29th, 2026 9:00 AM.";
    expect(detectCodexBannerLimit(t, NOW)!.resetsAt).toBe(parseResetTime('try again at Oct 29th, 2026 9:00 AM', NOW)!.at);
  });
  it('reads the "for <model>" and admin wordings', () => {
    expect(detectCodexBannerLimit("You've hit your usage limit for GPT-6 Astra. Switch to another model now, or try again at 3:10 PM.", NOW)).not.toBeNull();
    expect(detectCodexBannerLimit('You’ve hit your usage limit. To get more access now, send a request to your admin or try again at 3:10 PM.', NOW)).not.toBeNull();
  });
  it('a limit with no time is a limit with a null reset', () => {
    const l = detectCodexBannerLimit("You've hit your usage limit. Visit https://chatgpt.com/settings/usage to purchase more credits", NOW)!;
    expect(l.resetsAt).toBeNull();
  });
  it('survives screen codes and a time wrapped onto the next line', () => {
    const t = "\x1b[1m■\x1b[0m You've hit your usage limit. Upgrade to Plus to continue using Codex\r\n  (https://chatgpt.com/explore/plus), or try again at\r\n  9:15 AM.\r\n";
    expect(detectCodexBannerLimit(t, NOW)!.resetsAt).toBe(parseResetTime('try again at 9:15 AM', NOW)!.at);
  });
  it('prose that merely mentions the words is not a limit', () => {
    expect(detectCodexBannerLimit('The doc explains that when you hit your usage limit the CLI shows a banner.', NOW)).toBeNull();
    expect(detectCodexBannerLimit('Tests: "You\'ve hit your usage limit" is parsed by detectCodexLimit', NOW)).toBeNull();
    expect(detectCodexBannerLimit('npm test\nall green', NOW)).toBeNull();
  });
  it('reads a model name with dots in it', () => {
    const l = detectCodexBannerLimit("You've hit your usage limit for gpt-5.6-sol. Switch to another model now, or try again at 9:15 AM.", NOW)!;
    expect(l.resetsAt).toBe(parseResetTime('try again at 9:15 AM', NOW)!.at);
  });
  it('the Claude detector leaves a Codex message alone, wrapped or not', () => {
    expect(detectBannerLimit("You've hit your usage limit.\r\nUpgrade to Plus to continue using Codex, or try again at 9:15 AM.\r\n", NOW)).toBeNull();
    expect(detectBannerLimit("You've hit your usage limit. Upgrade to Plus to continue using Codex, or try again at 9:15 AM.", NOW)).toBeNull();
    expect(detectBannerLimit("You've hit your usage limit for GPT-6 Astra. Switch to another model now, or try again at 3:10 PM.", NOW)).toBeNull();
    // Claude's own timeless wording still parks.
    expect(detectBannerLimit("You've hit your usage limit\r\n", NOW)).not.toBeNull();
  });
  it('a Codex message quoted earlier on the screen does not hide a real Claude stop below it', () => {
    const screen = "You've hit your usage limit.\r\nUpgrade to Plus to continue using Codex, or try again at 9:15 AM.\r\nYou've hit your session limit · resets 1:10am (America/Indianapolis)\r\n";
    const l = detectBannerLimit(screen, NOW)!;
    expect(l.kind).toBe('session');
    expect(iso(l.resetsAt)).toBe('2026-10-24T05:10:00.000Z');
    // The quiet check measures from the real banner, not from the Codex quote.
    expect(textAfterBanner(screen)).toBeLessThan(5);
    expect(textAfterBanner("You've hit your usage limit.\r\nUpgrade to Plus to continue using Codex, or try again at 9:15 AM.\r\n")).toBe(0);
  });
  it('a banner quoted after a markdown marker or inside a code fence is not a stop', () => {
    const msg = "You've hit your usage limit. Upgrade to Plus to continue using Codex, or try again at 9:15 AM.";
    for (const quoted of [`> ${msg}`, `• ${msg}`, `- ${msg}`, `\`\`\`${msg}`, `\`\`\`\r\n${msg}\r\n\`\`\``]) {
      expect(detectCodexBannerLimit(quoted, NOW), quoted).toBeNull();
    }
  });
  it('a message two or more lines inside a fenced block is a quote, for Codex and Claude wording', () => {
    const codex = "You've hit your usage limit. Upgrade to Plus to continue using Codex, or try again at 9:15 AM.";
    const claude = "You've hit your session limit · resets 1:10am (America/Indianapolis)";
    for (const fence of ['```', '~~~', '```text']) {
      const close = fence.slice(0, 3);
      const inside = (msg: string) => `${fence}\r\nfirst line\r\nsecond line\r\n${msg}\r\nmore\r\n${close}\r\n`;
      expect(detectCodexBannerLimit(inside(codex), NOW), `codex ${fence}`).toBeNull();
      expect(detectBannerLimit(inside(claude), NOW), `claude ${fence}`).toBeNull();
      expect(textAfterCodexBanner(inside(codex)), `after codex ${fence}`).toBe(0);
      expect(textAfterBanner(inside(claude)), `after claude ${fence}`).toBe(0);
    }
    // A block that never closes in the window quotes nothing (see the fence rule below).
    expect(detectCodexBannerLimit(`\`\`\`\r\na\r\nb\r\n■ ${codex}\r\n`, NOW)).not.toBeNull();
  });
  it('a real stop after a closed fence still parks', () => {
    const codex = "■ You've hit your usage limit. Upgrade to Plus to continue using Codex, or try again at 9:15 AM.";
    const claude = "  ⎿  You've hit your session limit · resets 1:10am (America/Indianapolis)";
    const block = '```\r\nconst a = 1;\r\nconst b = 2;\r\n```\r\n';
    expect(detectCodexBannerLimit(block + codex + '\r\n', NOW)).not.toBeNull();
    expect(detectBannerLimit(block + claude + '\r\n', NOW)?.kind).toBe('session');
    // A fenced quote earlier, a real stop after it: the stop is the one found.
    const quoted = '```\r\nx\r\ny\r\n' + "You've hit your session limit · resets 9:00am (America/Indianapolis)" + '\r\n```\r\n';
    expect(iso(detectBannerLimit(quoted + claude + '\r\n', NOW)!.resetsAt)).toBe('2026-10-24T05:10:00.000Z');
  });
  // The fence rule: limit text is quoted only between an opening fence and a matching closing fence
  // AFTER it (same character, closing at least as long). An unclosed fence above it, or a closing
  // fence with no opener in the window, quotes nothing.
  describe('fence rule', () => {
    const codexMsg = "You've hit your usage limit. Upgrade to Plus to continue using Codex, or try again at 9:15 AM.";
    const claudeMsg = "  ⎿  You've hit your session limit · resets 1:10am (America/Indianapolis)";
    const stops = (prefix: string, suffix = '') => ({
      claude: detectBannerLimit(prefix + claudeMsg + '\r\n' + suffix, NOW),
      codex: detectCodexBannerLimit(prefix + '■ ' + codexMsg + '\r\n' + suffix, NOW),
    });
    it('a real stop is found when an unclosed fence is above it (a collapsed tool preview cut the block)', () => {
      const r = stops('● Read(notes.md)\r\n  ⎿  ```md\r\n     # notes\r\n     … +40 lines (ctrl+r to expand)\r\n');
      // the "```md" here is prefixed by the TUI gutter, so it is no fence line at all
      expect(r.claude?.kind).toBe('session');
      expect(r.codex).not.toBeNull();
      const bare = stops('```md\r\n# notes\r\n… +40 lines (ctrl+r to expand)\r\n');
      expect(bare.claude?.kind, 'unclosed bare fence above').toBe('session');
      expect(bare.codex, 'unclosed bare fence above').not.toBeNull();
    });
    it('a real stop is found when only a closing fence is in the window (the opener scrolled out of it)', () => {
      const r = stops('some code\r\nmore code\r\n```\r\nDone.\r\n');
      expect(r.claude?.kind).toBe('session');
      expect(r.codex).not.toBeNull();
    });
    it('a prefixed fence line is not a fence: stops after it are found', () => {
      for (const prefixed of ['  ⎿  ```', '> ```', '│ ```', '● ```js']) {
        const r = stops(`${prefixed}\r\ncode\r\n`);
        expect(r.claude?.kind, prefixed).toBe('session');
        expect(r.codex, prefixed).not.toBeNull();
      }
    });
    it('a stop after two separate closed blocks is found; a stray opener after a closed block does not quote', () => {
      const r = stops('```\r\na\r\n```\r\ntext\r\n~~~\r\nb\r\n~~~\r\n');
      expect(r.claude?.kind).toBe('session');
      expect(r.codex).not.toBeNull();
      const stray = stops('```\r\na\r\n```\r\n```\r\nc\r\n');
      expect(stray.claude?.kind).toBe('session');
    });
    it('a block closed by a longer fence of the same character quotes what is inside it', () => {
      const inner = (open: string, close: string) => `${open}\r\nx\r\n${claudeMsg}\r\n${close}\r\n`;
      expect(detectBannerLimit(inner('```', '````'), NOW)).toBeNull();
      expect(detectBannerLimit(inner('~~~', '~~~~~'), NOW)).toBeNull();
      expect(detectCodexBannerLimit(`\`\`\`\r\nx\r\n■ ${codexMsg}\r\n\`\`\`\`\r\n`, NOW)).toBeNull();
    });
    it('shorter or mixed delimiters do not close a block', () => {
      // 4-backtick opener is not closed by 3 backticks or by tildes: nothing is quoted
      const shortClose = `\`\`\`\`\r\nx\r\n${claudeMsg}\r\n\`\`\`\r\n`;
      expect(detectBannerLimit(shortClose, NOW)?.kind).toBe('session');
      const mixedClose = `\`\`\`\r\nx\r\n${claudeMsg}\r\n~~~\r\n`;
      expect(detectBannerLimit(mixedClose, NOW)?.kind).toBe('session');
    });
    it('a nested shorter fence inside a longer block does not end it', () => {
      const body = `\`\`\`\`md\r\n\`\`\`\r\ninner\r\n\`\`\`\r\nx\r\n■ ${codexMsg}\r\n\`\`\`\`\r\n`;
      expect(detectCodexBannerLimit(body, NOW)).toBeNull();
      // and a closing fence with words after it is not a closer
      const notCloser = `\`\`\`\r\nx\r\n${claudeMsg}\r\n\`\`\` trailing words\r\n`;
      expect(detectBannerLimit(notCloser, NOW)?.kind).toBe('session');
    });
    it('the blank-line and indentation forms of a closing fence work', () => {
      const text = `  \`\`\`js\r\nx\r\n${claudeMsg}\r\n  \`\`\`  \r\n`;
      expect(detectBannerLimit(text, NOW)).toBeNull();
    });
  });
  it('no prefix, indentation and the error mark are accepted', () => {
    const msg = "You've hit your usage limit. Upgrade to Plus to continue using Codex, or try again at 9:15 AM.";
    for (const ok of [msg, `■ ${msg}`, `  ■ ${msg}`, `  ${msg}`, `\x1b[31m■\x1b[0m ${msg}`]) expect(detectCodexBannerLimit(ok, NOW), ok).not.toBeNull();
  });
  it('finds the banner when the CLI wraps inside the opening words', () => {
    for (const wrapped of [
      "You've hit your usage\r\n  limit. Upgrade to Plus to continue using Codex (https://chatgpt.com/explore/plus), or try again at 9:15 AM.",
      "You've hit\r\n  your usage limit. Visit https://chatgpt.com/settings/usage to purchase more credits or try again at 9:15 AM.",
      "You've hit your usage limit for GPT-6\r\n  Astra. Switch to another model now, or try again at 9:15 AM.",
    ]) expect(detectCodexBannerLimit(wrapped, NOW)?.resetsAt, wrapped).toBe(parseResetTime('try again at 9:15 AM', NOW)!.at);
  });
  it('prose that starts with the phrase but is not one of the CLI messages is not a limit', () => {
    expect(detectCodexBannerLimit("You've hit your usage limit is the text this detector searches for.", NOW)).toBeNull();
    expect(detectCodexBannerLimit("You've hit your usage limit message appears when the quota is spent, and the daemon then parks the thread until it resets.", NOW)).toBeNull();
    expect(detectCodexBannerLimit("You've hit your usage limit. That is what the CLI prints, and the daemon reads it from the screen.", NOW)).toBeNull();
  });
  it('the Claude banner is not a Codex banner, and the other way round', () => {
    expect(detectCodexBannerLimit("You've hit your session limit · resets 1:10am (America/Indianapolis)", NOW)).toBeNull();
    expect(detectBannerLimit(plus, NOW)).toBeNull();
  });
  it('counts the letters left on the screen after the banner', () => {
    expect(textAfterCodexBanner(plus + '\r\n\r\n> ')).toBeLessThan(10);
    expect(textAfterCodexBanner(plus + '\r\nSo what that means in practice is that the agent keeps explaining things for a long time afterwards, with many words.')).toBeGreaterThan(60);
  });
});

describe('detectGrokLimit (Grok ACP retry_state)', () => {
  const exhausted = {
    sessionUpdate: 'retry_state', type: 'exhausted', attempts: 0, is_rate_limited: true,
    reason: "API error (status 429 Too Many Requests): subscription:free-usage-exhausted: You've used all the included free usage for model grok-4.7 for now. Usage resets over a rolling 24-hour window — tokens (actual/limit): 626631/600000. Upgrade to a Grok subscription for higher limits: https://grok.com/supergrok",
  };
  it('the real free-usage stop is a usage limit with no reset time', () => {
    const l = detectGrokLimit(exhausted, NOW)!;
    expect(l.kind).toBe('usage');
    expect(l.resetsAt).toBeNull();
    expect(l.message).toContain('free-usage-exhausted');
  });
  it('a retry that is still going is not a stop', () => {
    expect(detectGrokLimit({ sessionUpdate: 'retry_state', type: 'retrying', attempt: 1, max_retries: 15, error_type: 'rate_limited', reason: 'API error (status 429 Too Many Requests): Some resource has been exhausted: You are sending requests too quickly.' }, NOW)).toBeNull();
  });
  it('an exhausted retry that was not a rate limit (a doom loop) is not a usage limit', () => {
    expect(detectGrokLimit({ sessionUpdate: 'retry_state', type: 'exhausted', error_type: 'doom_loop_detected', reason: 'doom loop detected' }, NOW)).toBeNull();
  });
  it('reads a stop_reason of rate_limit with no retry_state before it', () => {
    const l = detectGrokLimit({ sessionUpdate: 'turn_completed', stop_reason: 'rate_limit' }, NOW)!;
    expect(l).toMatchObject({ kind: 'usage', resetsAt: null });
  });
  it('anything else is null', () => {
    expect(detectGrokLimit({ sessionUpdate: 'turn_completed', stop_reason: 'end_turn' }, NOW)).toBeNull();
    expect(detectGrokLimit(null as any, NOW)).toBeNull();
  });
});
