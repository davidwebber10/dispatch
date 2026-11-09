// Makes a synthetic Claude Code transcript (JSONL) of about `bytes` bytes. Used by the perf scripts.
import fs from 'node:fs';

/** One user turn, then assistant lines with text and usage. Deterministic: no random data. */
export function writeSyntheticTranscript(file, bytes) {
  const fd = fs.openSync(file, 'w');
  let written = 0;
  let i = 0;
  const filler = 'The quick brown fox jumps over the lazy dog. '.repeat(40);
  try {
    while (written < bytes) {
      const user = JSON.stringify({ type: 'user', uuid: `u-${i}`, timestamp: new Date(1_700_000_000_000 + i * 1000).toISOString(),
        message: { role: 'user', content: [{ type: 'text', text: `Question ${i}: ${filler.slice(0, 300)}` }] } }) + '\n';
      const assistant = JSON.stringify({ type: 'assistant', uuid: `a-${i}`, timestamp: new Date(1_700_000_000_500 + i * 1000).toISOString(),
        message: { id: `msg-${i}`, role: 'assistant', model: 'claude-sonnet-4-5',
          content: [{ type: 'text', text: `Answer ${i}: ${filler}` }],
          usage: { input_tokens: 100 + (i % 7), output_tokens: 50 + (i % 5), cache_read_input_tokens: 1000, cache_creation_input_tokens: 10 } } }) + '\n';
      written += fs.writeSync(fd, user);
      written += fs.writeSync(fd, assistant);
      i++;
    }
  } finally { fs.closeSync(fd); }
  return { turns: i, bytes: written };
}
