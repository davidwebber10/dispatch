import { describe, it, expect } from 'vitest';
import { firstMessage, lastMessage, nodeName, parentOf, childrenOf, siblingOf, fromName, pairDue, mostDuePair, type Line } from '../../src/endless/tree.js';

describe('tree math', () => {
  it('names node(3,5) as 40+8 and covers messages 40..47', () => {
    expect(nodeName(3, 5)).toBe('40+8');
    expect(firstMessage(3, 5)).toBe(40);
    expect(lastMessage(3, 5)).toBe(47);
  });
  it('relates parents, children, and siblings', () => {
    expect(parentOf(0, 7)).toEqual({ l: 1, i: 3 });
    expect(childrenOf(2, 1)).toEqual([{ l: 1, i: 2 }, { l: 1, i: 3 }]);
    expect(siblingOf(1, 2)).toEqual({ l: 1, i: 3 });
    expect(siblingOf(1, 3)).toEqual({ l: 1, i: 2 });
    expect(() => childrenOf(0, 4)).toThrow();
  });
  it('parses id+n names and rejects bad ones', () => {
    expect(fromName(40, 8)).toEqual({ l: 3, i: 5 });
    expect(fromName(9, 1)).toEqual({ l: 0, i: 9 });
    expect(fromName(40, 6)).toBeNull();
    expect(fromName(12, 8)).toBeNull();
    expect(fromName(-1, 1)).toBeNull();
  });
  it('due is (T - last) / 2^l with last the pair\'s LAST message', () => {
    expect(pairDue(0, 8, 10)).toBe(1);       // 8+1, 9+1: last 9
    expect(pairDue(2, 0, 10)).toBe(0.75);    // 0+4, 4+4: last 7
  });
  it('first-vs-last regression: at T=10 with 0+4, 4+4, 8+1, 9+1 it merges 8-9, not 0-7', () => {
    const lines: Line[] = [[2, 0], [2, 1], [0, 8], [0, 9]];
    expect(mostDuePair(lines, 10, () => true)).toBe(2);
  });
  it('skips pairs whose parent is not built and breaks ties toward the oldest pair', () => {
    const lines: Line[] = [[0, 0], [0, 1], [0, 2], [0, 3]];
    expect(mostDuePair(lines, 4, () => true)).toBe(0); // 0-1 is more due than 2-3
    expect(mostDuePair(lines, 4, (l, i) => !(l === 1 && i === 0))).toBe(2);
    expect(mostDuePair([[1, 0], [0, 2], [0, 3]], 4, () => false)).toBe(-1);
    // A tie at T=7: 0+2,2+2 has due (7-3)/2 = 2; 4+1,5+1 has due (7-5)/1 = 2. The oldest wins.
    expect(mostDuePair([[1, 0], [1, 1], [0, 4], [0, 5], [0, 6]], 7, () => true)).toBe(0);
  });
  it('only pairs an even left index with its right sibling', () => {
    expect(mostDuePair([[0, 1], [0, 2]], 3, () => true)).toBe(-1);
  });
});
