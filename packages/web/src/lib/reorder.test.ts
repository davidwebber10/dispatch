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
    const arr = ['a', 'b', 'c'];
    expect(reorderIds(arr, 'b', 'b')).toBe(arr);
  });
  it('returns the same order for a null over', () => {
    const arr = ['a', 'b', 'c'];
    expect(reorderIds(arr, 'b', null)).toBe(arr);
  });
  it('returns the same order for an unknown id', () => {
    const arr = ['a', 'b', 'c'];
    expect(reorderIds(arr, 'x', 'b')).toBe(arr);
  });
});
