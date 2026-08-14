import { describe, it, expect } from 'vitest';
import { AuthUrlScanner, extractAuthUrls, looksLikeAuthUrl } from './url-detect.js';

describe('looksLikeAuthUrl', () => {
  it('accepts the sign-in URLs the agent CLIs actually print', () => {
    for (const url of [
      'https://claude.ai/oauth/authorize?code=1&state=x',
      'https://auth.openai.com/authorize?client_id=abc',
      'https://accounts.x.ai/sign-in?redirect=cli',
      'https://github.com/login/device',
      'https://example.com/activate?user_code=ABCD-EFGH',
      'https://id.example.com/verify/device',
    ]) {
      expect(looksLikeAuthUrl(url), url).toBe(true);
    }
  });

  it('ignores ordinary URLs a build or an agent prints all day', () => {
    for (const url of [
      'https://github.com/davidwebber10/dispatch/releases/tag/v2.12.0',
      'https://docs.x.ai/build/overview',
      'https://registry.npmjs.org/@openai/codex',
      'https://example.com/some/page',
      'https://vitejs.dev/guide/',
    ]) {
      expect(looksLikeAuthUrl(url), url).toBe(false);
    }
  });

  it('ignores loopback URLs — those are the callback leg, not the thing to open', () => {
    expect(looksLikeAuthUrl('http://localhost:1455/auth/callback?code=x')).toBe(false);
    expect(looksLikeAuthUrl('http://127.0.0.1:8080/oauth/callback')).toBe(false);
  });

  it('requires https — an http auth URL on the open internet is not one we relay', () => {
    expect(looksLikeAuthUrl('http://example.com/oauth/authorize')).toBe(false);
  });
});

describe('extractAuthUrls', () => {
  it('pulls the URL out of a normal CLI prompt', () => {
    const out = extractAuthUrls('Open this link to sign in:\n  https://accounts.x.ai/sign-in?code=abc123\n');
    expect(out).toEqual(['https://accounts.x.ai/sign-in?code=abc123']);
  });

  it('strips ANSI colour codes before matching', () => {
    const text = '\x1b[32mVisit\x1b[0m \x1b[4mhttps://github.com/login/device\x1b[0m';
    expect(extractAuthUrls(text)).toEqual(['https://github.com/login/device']);
  });

  it('rejoins a URL the PTY hard-wrapped mid-string', () => {
    // An 80-column terminal inserts a newline at the boundary with no space. This is the
    // same class of bug as the wrapped login token (commit 0138bf0).
    const head = 'https://accounts.x.ai/sign-in?client_id=abcdefghijklmnopqrstuvwxyz01&sta';
    expect(head.length).toBeGreaterThanOrEqual(60); // a real wrap only happens on a full line
    expect(extractAuthUrls(`${head}\nte=qrstuvwxyz0123456789`)).toEqual([
      'https://accounts.x.ai/sign-in?client_id=abcdefghijklmnopqrstuvwxyz01&state=qrstuvwxyz0123456789',
    ]);
  });

  it('rejoins across a CRLF wrap too', () => {
    const head = 'https://github.com/login/device?padding=to_reach_a_real_terminal_width&user_co';
    expect(head.length).toBeGreaterThanOrEqual(60);
    expect(extractAuthUrls(`${head}\r\nde=ABCD-EFGH`)).toEqual([
      'https://github.com/login/device?padding=to_reach_a_real_terminal_width&user_code=ABCD-EFGH',
    ]);
  });

  it('prefers the whole URL over the truncated fragment when both are visible', () => {
    const head = 'go to https://id.example.com/verify?token=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    expect(head.length).toBeGreaterThanOrEqual(60);
    const out = extractAuthUrls(`${head}\nbbbb now`);
    expect(out).toHaveLength(1);
    expect(out[0]).toBe('https://id.example.com/verify?token=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaabbbb');
  });

  it('does not glue a URL to the prose on the next line (a short line is not a wrap)', () => {
    // The regression that made the first implementation report ".../deviceEnter".
    const out = extractAuthUrls('https://github.com/login/device\nEnter the code shown above');
    expect(out).toEqual(['https://github.com/login/device']);
  });

  it('does not treat a genuine line break after the URL as a wrap', () => {
    const text = 'https://github.com/login/device\nEnter code ABCD-EFGH';
    expect(extractAuthUrls(text)).toEqual(['https://github.com/login/device']);
  });

  it('drops trailing punctuation the prose added', () => {
    expect(extractAuthUrls('Visit https://github.com/login/device.')).toEqual(['https://github.com/login/device']);
    expect(extractAuthUrls('Visit <https://github.com/login/device>')).toEqual(['https://github.com/login/device']);
    expect(extractAuthUrls('Visit (https://github.com/login/device)')).toEqual(['https://github.com/login/device']);
  });

  it('returns nothing for output with no auth URL', () => {
    expect(extractAuthUrls('npm WARN deprecated foo@1.0.0\nBuilt in 2.3s')).toEqual([]);
  });
});

describe('AuthUrlScanner', () => {
  it('reports an auth URL once, however many times it is reprinted', () => {
    const s = new AuthUrlScanner();
    expect(s.feed('t1', 'go to https://github.com/login/device\n')).toEqual(['https://github.com/login/device']);
    expect(s.feed('t1', 'still waiting: https://github.com/login/device\n')).toEqual([]);
  });

  it('finds a URL split across two chunks', () => {
    const s = new AuthUrlScanner();
    expect(s.feed('t1', 'Sign in at https://accounts.x.ai/sign-')).toEqual([]);
    expect(s.feed('t1', 'in?code=xyz789\n')).toEqual(['https://accounts.x.ai/sign-in?code=xyz789']);
  });

  it('keeps terminals independent — the same URL in another thread still reports', () => {
    const s = new AuthUrlScanner();
    expect(s.feed('t1', 'https://github.com/login/device\n')).toHaveLength(1);
    expect(s.feed('t2', 'https://github.com/login/device\n')).toHaveLength(1);
  });

  it('forgets a terminal, so a re-login in the same thread is relayed again', () => {
    const s = new AuthUrlScanner();
    expect(s.feed('t1', 'https://github.com/login/device\n')).toHaveLength(1);
    s.forget('t1');
    expect(s.feed('t1', 'https://github.com/login/device\n')).toHaveLength(1);
  });

  it('never grows its buffer without bound on a chatty terminal', () => {
    const s = new AuthUrlScanner();
    for (let i = 0; i < 200; i++) s.feed('t1', 'x'.repeat(500) + '\n');
    expect(s.bufferSize('t1')).toBeLessThanOrEqual(4096);
  });

  it('still finds a URL that arrives after a lot of noise', () => {
    const s = new AuthUrlScanner();
    for (let i = 0; i < 50; i++) s.feed('t1', `line ${i} of build output\n`);
    expect(s.feed('t1', 'Now visit https://auth.openai.com/authorize?x=1\n')).toEqual([
      'https://auth.openai.com/authorize?x=1',
    ]);
  });

  it('caps how many distinct URLs one terminal can report', () => {
    const s = new AuthUrlScanner();
    const seen: string[] = [];
    for (let i = 0; i < 40; i++) seen.push(...s.feed('t1', `https://id.example.com/verify?n=${i}\n`));
    // A terminal spraying auth-shaped URLs must not queue 40 banners.
    expect(seen.length).toBeLessThanOrEqual(10);
  });
});

describe('regressions found by running it against a real PTY', () => {
  it('drops a trailing percent — the shell prompt marker, never a valid escape', () => {
    // zsh prints a bare `%` after output with no trailing newline, and it landed inside the
    // URL because `%` is legal mid-URL (percent-encoding). A TRAILING one never is.
    expect(extractAuthUrls('https://accounts.x.ai/sign-in?code=abc123%')).toEqual([
      'https://accounts.x.ai/sign-in?code=abc123',
    ]);
  });

  it('keeps a real percent-escape inside the URL', () => {
    expect(extractAuthUrls('https://id.example.com/verify?next=%2Fhome%2Fx')).toEqual([
      'https://id.example.com/verify?next=%2Fhome%2Fx',
    ]);
  });

  it('drops a truncated percent-escape at the end', () => {
    expect(extractAuthUrls('https://id.example.com/verify?next=%2')).toEqual([
      'https://id.example.com/verify?next=',
    ]);
  });

  it('does not raise a banner for a URL that is still streaming in', () => {
    // The real bug: the same URL was reported twice — once with the prompt glued on, once
    // clean. A URL sitting at the very end of the buffer may not be finished yet.
    const s = new AuthUrlScanner();
    expect(s.feed('t1', 'go to https://accounts.x.ai/sign-in?code=abc123')).toEqual([]);
    expect(s.feed('t1', '\n')).toEqual(['https://accounts.x.ai/sign-in?code=abc123']);
  });

  it('reports one URL, not two, when the shell echoes the command and then runs it', () => {
    const s = new AuthUrlScanner();
    const out = [
      ...s.feed('t1', 'echo Visit https://accounts.x.ai/sign-in?code=abc123 to continue\r\n'),
      ...s.feed('t1', 'Visit https://accounts.x.ai/sign-in?code=abc123 to continue\r\n'),
      ...s.feed('t1', '%'),
    ];
    expect(out).toEqual(['https://accounts.x.ai/sign-in?code=abc123']);
  });
});

describe('the false-positive burst that this caused in the field', () => {
  it('never absorbs box-drawing or arrows printed next to a URL', () => {
    // Both observed for real: a URL inside a box-drawn TUI panel, and one followed by "←"
    // in prose. Each produced a percent-encoded, unusable URL in the banner.
    expect(extractAuthUrls('https://id.example.com/oauth2/device?user_cod──────')).toEqual([
      'https://id.example.com/oauth2/device?user_cod',
    ]);
    expect(extractAuthUrls('https://id.example.com/cai/oauth/auth← truncated')).toEqual([
      'https://id.example.com/cai/oauth/auth',
    ]);
  });

  it('keeps ordinary ASCII URLs intact', () => {
    expect(extractAuthUrls('https://accounts.example.com/oauth2/device?user_code=AB-CD\n')).toEqual([
      'https://accounts.example.com/oauth2/device?user_code=AB-CD',
    ]);
  });
});
