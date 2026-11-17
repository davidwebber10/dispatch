import { describe, it, expect } from 'vitest';
import { removeFillers, shouldCleanLanguage } from './cleanup.js';

describe('removeFillers: basic removal', () => {
  it.each([
    ['So, um, I think we should, uh, update the config file and, um, restart the server.',
     'So, I think we should update the config file and restart the server.'],
    ['Please open the, um, package.json file and, uh, change the port to, uh, 4000.',
     'Please open the package.json file and change the port to 4000.'],
    ['Please open the um package.json file, and uh change the port to uh 4000.',
     'Please open the package.json file, and change the port to 4000.'],
    ['I think, um, we should go.', 'I think we should go.'],
    ['the umm build failed', 'the build failed'],
    ['the uhh build failed', 'the build failed'],
    ['the uhm build failed', 'the build failed'],
    ['the erm build failed', 'the build failed'],
    ['the hmmm build failed', 'the build failed'],
    ['the hm build failed', 'the build failed'],
  ])('%s', (input, expected) => {
    expect(removeFillers(input)).toBe(expected);
  });
});

describe('removeFillers: position and capitalization', () => {
  it('drops a filler at the start of the text and capitalizes the next word', () => {
    expect(removeFillers('Um, let me think.')).toBe('Let me think.');
    expect(removeFillers('Uh, the build failed.')).toBe('The build failed.');
    expect(removeFillers('Hmm, interesting point.')).toBe('Interesting point.');
  });
  it('drops a filler that starts a later sentence and capitalizes the next word', () => {
    expect(removeFillers('It failed. Um, the test timed out.')).toBe('It failed. The test timed out.');
  });
  it('capitalizes a plain word even when a stop follows it directly', () => {
    expect(removeFillers('It ended Monday. Ah, wait. Hmm. Let me check.')).toBe('It ended Monday. Wait. Let me check.');
    expect(removeFillers('Um, okay!')).toBe('Okay!');
  });
  it('does not capitalize a filepath, identifier or number after the filler', () => {
    expect(removeFillers('Um, package.json is wrong.')).toBe('package.json is wrong.');
    expect(removeFillers('Uh, camelCase is wrong.')).toBe('camelCase is wrong.');
    expect(removeFillers('Uh, 4000 is the port.')).toBe('4000 is the port.');
  });
  it('drops a filler at the end of a sentence and keeps the full stop', () => {
    expect(removeFillers('We ship on Friday, um. Then we rest.')).toBe('We ship on Friday. Then we rest.');
    expect(removeFillers('We ship on Friday, um.')).toBe('We ship on Friday.');
    expect(removeFillers('Is it ready, uh?')).toBe('Is it ready?');
  });
  it('drops a filler that ends the text with no punctuation', () => {
    expect(removeFillers('We ship on Friday um')).toBe('We ship on Friday');
  });
  it('drops a sentence that is only a filler', () => {
    expect(removeFillers('Wait. Hmm. Let me check.')).toBe('Wait. Let me check.');
    expect(removeFillers('Let me check. Hmm.')).toBe('Let me check.');
  });
  it('handles two fillers in a row', () => {
    expect(removeFillers('Um, uh, the build failed.')).toBe('The build failed.');
    expect(removeFillers('We should, um, uh, go.')).toBe('We should go.');
  });
  it('keeps the comma after a sentence opener such as So or Well', () => {
    expect(removeFillers('Well, um, no.')).toBe('Well, no.');
  });
  it('handles an opening filler followed by an opener', () => {
    expect(removeFillers('Ah, wait, hmm, let me check the schedule.')).toBe('Wait, let me check the schedule.');
  });
  it('returns an empty string when the text is only fillers', () => {
    expect(removeFillers('Um.')).toBe('');
    expect(removeFillers('Um, uh, hmm')).toBe('');
  });
  it('keeps the original spacing and line breaks of the rest of the text', () => {
    expect(removeFillers('First line.\nUm, second line.')).toBe('First line.\nSecond line.');
  });
});

describe('removeFillers: real words and phrases stay', () => {
  it.each([
    'The umbrella is open.',
    'Umpire, humble, summer, number, drummer.',
    'The user is a hummingbird fan.',
    'Hum along. Erase the file. Her answer was clear.',
    'The error is here. Ahead of schedule. Aha, I see.',
    'She said uh-huh and he said uh huh.',
    'Mm-hmm, that works.',
    'Uh-oh, the build broke.',
    'The ER is open. Go to the ER now.',
    'Use the um-lang flag.',
    "Don't say um's.",
  ])('leaves alone: %s', (text) => {
    expect(removeFillers(text)).toBe(text);
  });
  it('leaves an all-caps two-letter token alone (ER, AH, UM, UH)', () => {
    expect(removeFillers('Send him to the ER, please.')).toBe('Send him to the ER, please.');
    expect(removeFillers('The UM office called.')).toBe('The UM office called.');
  });
  it('removes an all-caps three-letter filler form', () => {
    expect(removeFillers('in the UHH comment')).toBe('in the comment');
  });
  it('does not touch a filler inside quotes (ambiguous)', () => {
    expect(removeFillers('I said, "Ah, that is the answer."')).toBe('I said, "Ah, that is the answer."');
    expect(removeFillers('He wrote "um" in the box.')).toBe('He wrote "um" in the box.');
    expect(removeFillers('She said “Ah, I see.”')).toBe('She said “Ah, I see.”');
  });
  it('still removes fillers outside the quotes in the same text', () => {
    expect(removeFillers('I said, "Ah, that is it," and, um, left.')).toBe('I said, "Ah, that is it," and left.');
  });
});

describe('removeFillers: input edge cases', () => {
  it('returns an empty string unchanged', () => {
    expect(removeFillers('')).toBe('');
  });
  it('returns text with no filler unchanged, including odd spacing', () => {
    expect(removeFillers('  Two  spaces stay.  ')).toBe('  Two  spaces stay.  ');
  });
  it('does not loop on long input', () => {
    const t = 'word, um, '.repeat(2000);
    const out = removeFillers(t);
    expect(out.includes('um')).toBe(false);
  });
});

describe('shouldCleanLanguage', () => {
  it('cleans English and unknown language', () => {
    expect(shouldCleanLanguage(undefined, undefined)).toBe(true);
    expect(shouldCleanLanguage('en', undefined)).toBe(true);
    expect(shouldCleanLanguage(undefined, 'en_us')).toBe(true);
    expect(shouldCleanLanguage('en-GB', 'english')).toBe(true);
    expect(shouldCleanLanguage('EN', 'EN')).toBe(true);
  });
  it('skips any other language, because er and um are real words in some of them', () => {
    expect(shouldCleanLanguage('de', undefined)).toBe(false);
    expect(shouldCleanLanguage(undefined, 'german')).toBe(false);
    expect(shouldCleanLanguage('en', 'de')).toBe(false);
  });
});
