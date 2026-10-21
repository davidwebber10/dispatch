import { describe, it, expect } from 'vitest';
import { stateFromStatus } from './threadView';

describe('stateFromStatus', () => {
  it('the live overlay wins over the pane row', () => {
    expect(stateFromStatus('needs_input', undefined, 'working')).toBe('needs_you');
    expect(stateFromStatus('working', 'working', 'done')).toBe('working');
    expect(stateFromStatus('error', undefined, null)).toBe('error');
    expect(stateFromStatus('waiting', 'done', 'working')).toBe('done');
    expect(stateFromStatus('waiting', 'idle', 'idle')).toBe('idle');
  });
  it('no overlay keeps the pane row', () => {
    expect(stateFromStatus(undefined, undefined, 'queued')).toBe('queued');
    expect(stateFromStatus(undefined, undefined, null)).toBeNull();
  });
});
