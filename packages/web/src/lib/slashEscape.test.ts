import { describe, it, expect } from 'vitest';
import { textToSend } from './slashEscape';

describe('textToSend', () => {
  it('trims like before', () => {
    expect(textToSend('  hello  ')).toBe('hello');
    expect(textToSend('\n\nfix it\n')).toBe('fix it');
    expect(textToSend('   ')).toBe('');
  });
  it('keeps one leading space in front of a slash: the escape', () => {
    expect(textToSend(' /model opus')).toBe(' /model opus');
    expect(textToSend('   /effort high  ')).toBe(' /effort high');
    expect(textToSend('\n/path/to/file')).toBe(' /path/to/file');
  });
  it('leaves a plain slash message alone (the daemon decides what it is)', () => {
    expect(textToSend('/model opus')).toBe('/model opus');
  });
});
