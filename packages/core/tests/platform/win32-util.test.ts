import { describe, expect, test } from 'vitest';
import { parseTasklistPids } from '../../src/platform/win32-util.js';

describe('parseTasklistPids', () => {
  test('extracts PIDs from `tasklist /FO CSV /NH` output', () => {
    const csv = [
      '"System Idle Process","0","Services","0","8 K"',
      '"node.exe","4363","Console","1","52,000 K"',
      '"powershell.exe","7576","Console","1","80,000 K"',
    ].join('\r\n');
    expect(parseTasklistPids(csv)).toEqual([0, 4363, 7576]);
  });
  test('ignores blank lines and malformed rows', () => {
    expect(parseTasklistPids('\r\n"bad row"\r\n"x","notanumber","y","z","w"\r\n')).toEqual([]);
  });
});
