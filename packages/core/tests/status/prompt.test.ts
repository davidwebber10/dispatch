import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { detectPrompt } from '../../src/status/prompt.js';
import { renderScreen } from '../../src/status/screen.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const renderFx = (name: string) => renderScreen(fs.readFileSync(path.join(__dirname, '../fixtures/prompts', name), 'utf8'));

describe('detectPrompt', () => {
  it('returns null for a non-prompt / idle screen', () => {
    expect(detectPrompt('claude-code', 'assistant said something\n> ')).toBeNull();
    expect(detectPrompt('claude-code', '')).toBeNull();
  });

  it('detects a (y/n) confirm', () => {
    const p = detectPrompt('claude-code', 'Overwrite the file? (y/n)')!;
    expect(p.kind).toBe('confirm');
    expect(p.options).toEqual([{ label: 'Yes', keys: 'y' }, { label: 'No', keys: 'n' }]);
  });

  it('detects a numbered select and maps options to arrow-nav-from-cursor + Enter', () => {
    const screen = 'Which approach?\n❯ 1. MVP first\n  2. Risk first\n  3. User first\nEnter to confirm · Esc to cancel';
    const p = detectPrompt('claude-code', screen)!;
    expect(p.kind).toBe('select');
    expect(p.question).toBe('Which approach?');
    expect(p.options).toEqual([
      { label: 'MVP first', keys: '\r' },
      { label: 'Risk first', keys: '\x1b[B\r' },
      { label: 'User first', keys: '\x1b[B\x1b[B\r' },
    ]);
  });

  it('parses the real Claude trust prompt (select, cursor on option 1)', async () => {
    const p = detectPrompt('claude-code', await renderFx('claude-trust-folder.txt'))!;
    expect(p.kind).toBe('select');
    expect(p.question.toLowerCase()).toContain('trust');
    expect(p.options[0].label).toContain('Yes, I trust this folder');
    expect(p.options[0].keys).toBe('\r');
    expect(p.options[1].keys).toBe('\x1b[B\r');
  });

  it('parses the real Claude browser select prompt', async () => {
    const p = detectPrompt('claude-code', await renderFx('claude-select.txt'))!;
    expect(p.kind).toBe('select');
    expect(p.options.map((o) => o.label)).toEqual(['Yes, use my browser', 'No, keep browser tools off']);
  });

  it('parses the real Codex trust prompt (› cursor)', async () => {
    const p = detectPrompt('codex', await renderFx('codex-trust.txt'))!;
    expect(p.kind).toBe('select');
    expect(p.options[0].label).toBe('Yes, continue');
    expect(p.options[1].label).toBe('No, quit');
    expect(p.options[0].keys).toBe('\r');
  });

  it('does NOT match a numbered list in normal output (no cursor, no submit footer)', () => {
    // Real false positive: claude listing questions in prose, not an interactive menu.
    const screen = 'Here are a couple of open questions:\n1. How long did it actually take you (one person, with AI)?\n2. The "team for a year" estimate — who said it, and what size team?';
    expect(detectPrompt('claude-code', screen)).toBeNull();
  });

  it('does NOT false-positive on a normal working screen with a queued message', () => {
    const screen = '❯ write an essay\n✢ Forming…\n  ❯ what is the capital of france\n────\n❯ Press up to edit queued messages\n────\n proj │ Opus 4.8 │ bypass permissions on';
    expect(detectPrompt('claude-code', screen)).toBeNull();
  });

  it('falls back (parsed:false) for a cursor list with no numbered options', () => {
    const screen = 'Resume which session?\n❯ fix the login bug — 2h ago\n  add dark mode — yesterday\nEnter to confirm · Esc to cancel';
    const p = detectPrompt('claude-code', screen)!;
    expect(p.parsed).toBe(false);
    expect(p.raw).toContain('Resume which session');
  });
});
