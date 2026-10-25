import { describe, expect, it } from 'vitest';
import { truncate } from '../src/index.js';

describe('truncate', () => {
  it('returns the string unchanged when it fits', () => {
    expect(truncate('hello', 5)).toBe('hello');
    expect(truncate('hello', 10)).toBe('hello');
  });

  it('cuts and appends an ellipsis within max characters', () => {
    expect(truncate('hello world', 6)).toBe('hello…');
  });

  it('never splits a surrogate pair at the cut point', () => {
    expect(truncate('ab😀cd', 4)).toBe('ab😀…');
    expect(truncate('ab😀cd', 3)).toBe('ab…');
    expect(truncate('😀😀😀', 3)).toBe('😀😀😀');
  });

  it('returns an empty string when max is 0', () => {
    expect(truncate('abc', 0)).toBe('');
  });

  it('handles tiny and non-positive max', () => {
    expect(truncate('hello', 1)).toBe('…');
    expect(truncate('hello', 0)).toBe('');
    expect(truncate('hello', -3)).toBe('');
  });
});
