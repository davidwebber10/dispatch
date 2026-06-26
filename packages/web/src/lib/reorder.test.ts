import { describe, it, expect } from 'vitest';
import { reorderIds } from './reorder';

describe('reorderIds', () => {
  it('moves an item down to the over position', () => {
    expect(reorderIds(['a', 'b', 'c', 'd'], 'a', 'c')).toEqual(['b', 'c', 'a', 'd']);
  });
  it('moves an item up to the over position', () => {
    expect(reorderIds(['a', 'b', 'c', 'd'], 'd', 'b')).toEqual(['a', 'd', 'b', 'c']);
  });
  it('returns the same order when dropped on itself', () => {
    expect(reorderIds(['a', 'b', 'c'], 'b', 'b')).toEqual(['a', 'b', 'c']);
  });
  it('returns the same order for a null over', () => {
    expect(reorderIds(['a', 'b', 'c'], 'b', null)).toEqual(['a', 'b', 'c']);
  });
  it('returns the same order for an unknown id', () => {
    expect(reorderIds(['a', 'b', 'c'], 'x', 'b')).toEqual(['a', 'b', 'c']);
  });
});
