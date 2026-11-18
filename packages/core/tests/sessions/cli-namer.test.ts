import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  claudeTitleGenerator, codexTitleGenerator, firstTitle,
  CLAUDE_TITLE_MODEL, CODEX_TITLE_MODEL, pickCodexTitleModel, type CommandRunner,
} from '../../src/sessions/cli-namer.js';

const env = () => ({ PATH: '/bin' });
const installed = async (n: string) => `/usr/local/bin/${n}`;
const signedIn = async () => true as const;

describe('claudeTitleGenerator', () => {
  it('runs claude -p on Haiku with no tools, MCP, settings or session, prompt on stdin', async () => {
    const run = vi.fn<CommandRunner>().mockResolvedValue({ code: 0, stdout: '"Fix login redirect."\n' });
    const title = await claudeTitleGenerator({ env, run, bin: installed, signedIn })('fix the login redirect please');
    expect(title).toBe('Fix login redirect');
    const [bin, args, opts] = run.mock.calls[0];
    expect(bin).toBe('/usr/local/bin/claude');
    expect(args[args.indexOf('--model') + 1]).toBe(CLAUDE_TITLE_MODEL);
    for (const flag of ['-p', '--strict-mcp-config', '--no-session-persistence', '--disable-slash-commands']) expect(args).toContain(flag);
    expect(args[args.indexOf('--tools') + 1]).toBe('');
    expect(args.join(' ')).not.toContain('login redirect'); // the prompt never rides argv
    expect(opts.stdin).toContain('<conversation>\nfix the login redirect please\n</conversation>');
  });

  it('skips a CLI that is signed out or not installed, and treats a failed run as no title', async () => {
    const run = vi.fn<CommandRunner>().mockResolvedValue({ code: 0, stdout: 'Title' });
    expect(await claudeTitleGenerator({ env, run, bin: installed, signedIn: async () => false })('x y')).toBeNull();
    expect(await claudeTitleGenerator({ env, run, bin: async () => null, signedIn })('x y')).toBeNull();
    expect(run).not.toHaveBeenCalled();
    const failing = vi.fn<CommandRunner>().mockResolvedValue({ code: 1, stdout: 'Failed to authenticate' });
    expect(await claudeTitleGenerator({ env, run: failing, bin: installed, signedIn })('x y')).toBeNull();
  });

  it("tries the CLI when its sign-in state is 'unknown'", async () => {
    const run = vi.fn<CommandRunner>().mockResolvedValue({ code: 0, stdout: 'Some title' });
    expect(await claudeTitleGenerator({ env, run, bin: installed, signedIn: async () => 'unknown' })('x y')).toBe('Some title');
  });
});

describe('codexTitleGenerator', () => {
  it('runs codex exec on Terra and reads the final reply from its -o file', async () => {
    const run = vi.fn<CommandRunner>().mockImplementation(async (_bin, args) => {
      fs.writeFileSync(args[args.indexOf('-o') + 1], 'Mobile gradient and tab sync\n');
      return { code: 0, stdout: 'codex\nlog noise' };
    });
    const title = await codexTitleGenerator({ env, run, bin: installed, signedIn, codexModel: () => CODEX_TITLE_MODEL })('remove the gradient');
    expect(title).toBe('Mobile gradient and tab sync');
    const args = run.mock.calls[0][1];
    expect(args[0]).toBe('exec');
    expect(args[args.indexOf('-m') + 1]).toBe(CODEX_TITLE_MODEL);
    expect(args).toContain('--ephemeral');
    expect(fs.existsSync(args[args.indexOf('-o') + 1])).toBe(false); // cleaned up
  });
});

describe('pickCodexTitleModel', () => {
  const cache = (models: object[]) => {
    const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-models-')), 'models_cache.json');
    fs.writeFileSync(p, JSON.stringify({ models }));
    return p;
  };
  it('prefers 6.1 Terra when Codex lists it, else 5.6 Terra, else 6 Luna (also when the list cannot be read)', () => {
    expect(pickCodexTitleModel(cache([{ slug: 'gpt-5.6-terra' }, { slug: 'gpt-6.1-terra', visibility: 'list' }]))).toBe('gpt-6.1-terra');
    expect(pickCodexTitleModel(cache([{ slug: 'gpt-6.1-terra', visibility: 'hide' }, { slug: 'gpt-5.6-terra' }]))).toBe('gpt-5.6-terra');
    expect(pickCodexTitleModel(cache([{ slug: 'gpt-6.1-terra', visibility: 'hide' }, { slug: 'gpt-6-luna' }]))).toBe('gpt-6-luna');
    expect(pickCodexTitleModel('/nope/models_cache.json')).toBe('gpt-6-luna');
  });
});

describe('firstTitle', () => {
  it('takes the first generator that returns a title, in order, and survives a throw', async () => {
    const calls: string[] = [];
    const g = (name: string, out: string | null | Error) => async () => { calls.push(name); if (out instanceof Error) throw out; return out; };
    const title = await firstTitle([g('claude', new Error('boom')), g('codex', null), g('openrouter', 'From OpenRouter'), g('never', 'x')])('t');
    expect(title).toBe('From OpenRouter');
    expect(calls).toEqual(['claude', 'codex', 'openrouter']);
  });
});
