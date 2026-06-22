import xterm from '@xterm/headless';

const { Terminal } = xterm;

/**
 * Render raw PTY output into the visible screen text.
 *
 * Claude/Codex TUIs paint with absolute cursor positioning (e.g. `\x1b[<n>G`),
 * so naive ANSI-stripping collapses all spacing. We instead feed the bytes to a
 * headless terminal emulator and read its screen grid, which reconstructs the
 * exact on-screen text. Async because xterm parses writes on a queue and signals
 * completion via callback.
 */
export function renderScreen(raw: string, cols = 120, rows = 40): Promise<string> {
  return new Promise((resolve) => {
    const term = new Terminal({ cols, rows, allowProposedApi: true });
    term.write(raw, () => {
      const buf = term.buffer.active;
      const lines: string[] = [];
      for (let i = 0; i < buf.length; i++) {
        lines.push((buf.getLine(i)?.translateToString(true) ?? '').replace(/\s+$/, ''));
      }
      try { term.dispose(); } catch { /* best effort */ }
      resolve(lines.join('\n').replace(/^\n+|\n+$/g, ''));
    });
  });
}
