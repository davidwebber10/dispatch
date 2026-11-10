import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Wave 3 integration: W3-A moved the structured upgrade into daemon/sockets.ts, and W3-C passes the
// status service to it (the first frame is the status snapshot). The merge must keep that argument.
// The end-to-end pass on a built daemon checks the frame itself.
describe('the structured upgrade passes the status service', () => {
  it('handleStructuredConnection gets i.statusService as its status source', () => {
    const src = fs.readFileSync(path.join(__dirname, 'sockets.ts'), 'utf8');
    const call = src.slice(src.indexOf('handleStructuredConnection('), src.indexOf('handleTerminalConnection('));
    expect(call).toMatch(/i\.statusService,?\s*(\/\/.*)?\n\s*\);/);
  });
});
