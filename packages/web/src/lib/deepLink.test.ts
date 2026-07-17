import { describe, it, expect } from 'vitest';
import { parseThreadPath } from './deepLink';

describe('parseThreadPath', () => {
  it('parses /p/<sessionId>/t/<terminalId>', () => {
    expect(parseThreadPath('/p/s-123/t/t-456')).toEqual({ sessionId: 's-123', terminalId: 't-456' });
  });
  it('rejects everything else', () => {
    expect(parseThreadPath('/')).toBeNull();
    expect(parseThreadPath('/p/s-123')).toBeNull();
    expect(parseThreadPath('/p/s-123/a/agent-1')).toBeNull();
    expect(parseThreadPath('/p/s-123/t/t-456/extra')).toBeNull();
  });
});
