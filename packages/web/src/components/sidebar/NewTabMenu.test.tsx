import { render, screen, fireEvent } from '@testing-library/react';
import { test, expect, vi } from 'vitest';
import { NewTabMenu } from './NewTabMenu';
import { api } from '../../api/client';

vi.mock('../../api/client', () => ({
  api: {
    createTerminal: vi.fn(),
  },
}));

const CASES: [RegExp, string][] = [
  [/^Claude Code$/i, 'claude-code'],
  [/Claude \(structured\)/i, 'claude-structured'],
  [/^Codex$/i, 'codex'],
  [/^Terminal$/i, 'shell'],
];

test('offers a Claude (structured) option', () => {
  render(<NewTabMenu onClose={() => {}} onPick={() => {}} />);
  expect(screen.getByText(/Claude \(structured\)/i)).toBeInTheDocument();
});

for (const [pattern, kind] of CASES) {
  test(`clicking "${kind}" calls onPick with that kind and does not create a terminal`, () => {
    const onPick = vi.fn();
    const onClose = vi.fn();
    render(<NewTabMenu onClose={onClose} onPick={onPick} />);
    fireEvent.click(screen.getByText(pattern));
    expect(onPick).toHaveBeenCalledWith(kind);
    expect(onClose).toHaveBeenCalled();
    expect(api.createTerminal).not.toHaveBeenCalled();
  });
}
