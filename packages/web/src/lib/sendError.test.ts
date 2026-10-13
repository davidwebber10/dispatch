import { describe, it, expect } from 'vitest';
import { sendFailureText } from './sendError';

describe('sendFailureText', () => {
  it("adds the server's reason that the API client carried", () => {
    const err = new Error('POST /api/terminals/t1/message failed: 400 — could not start the thread: spawn claude ENOENT');
    expect(sendFailureText(err)).toBe('Failed to send message: could not start the thread: spawn claude ENOENT');
  });
  it('stays the plain text when there is no reason', () => {
    expect(sendFailureText(new Error('400'))).toBe('Failed to send message');
    expect(sendFailureText('nope')).toBe('Failed to send message');
  });
});
