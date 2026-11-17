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

describe('removeFillers: filenames, identifiers and code', () => {
  it.each([
    'Open um.txt.',
    'Check uh.txt now.',
    'Use the um.js file.',
    'ah.py is broken.',
    'Set um=1.',
    'Set x=um and y=uh.',
    'Open src/um/index.ts.',
    'Email um@example.com.',
    'Use the --um flag.',
  ])('leaves alone: %s', (text) => {
    expect(removeFillers(text)).toBe(text);
  });
  it('still removes a filler that ends a sentence next to a dot', () => {
    expect(removeFillers('We ship Friday, um. Then we rest.')).toBe('We ship Friday. Then we rest.');
  });
});

describe('removeFillers: quotes, brackets and dashes', () => {
  it.each([
    'He said "um" and left.',
    'He said um" and left.',
    'He said "um and left.',
    'Say \u201Cuh\u201D now.',
    'The (um) value.',
    'A [uh] test.',
    'Run `um` now.',
    'It was um\u2014good.',
    'It was um\u2013good.',
    'Pick uh/um now.',
  ])('leaves alone: %s', (text) => {
    expect(removeFillers(text)).toBe(text);
  });
});

describe('removeFillers: one-word openers', () => {
  it('drops the comma after a one-word opener that does not take one', () => {
    expect(removeFillers('I, um, think so.')).toBe('I think so.');
    expect(removeFillers('What, um, is that?')).toBe('What is that?');
    expect(removeFillers('But, uh, it works.')).toBe('But it works.');
  });
  it('keeps the comma after a discourse opener', () => {
    expect(removeFillers('So, um, I think so.')).toBe('So, I think so.');
    expect(removeFillers('Actually, uh, no.')).toBe('Actually, no.');
  });
});

describe('removeFillers: lists', () => {
  it('keeps the list comma', () => {
    expect(removeFillers('We need apples, bananas, um, and oranges.')).toBe('We need apples, bananas, and oranges.');
    expect(removeFillers('one, two, um, three')).toBe('one, two, three');
  });
  it('keeps the comma after a one-word clause with an earlier comma', () => {
    expect(removeFillers('Actually, no, um, on Monday.')).toBe('Actually, no, on Monday.');
  });
  it('does not keep a comma that came from another filler', () => {
    expect(removeFillers('Open the, um, file and, uh, save it.')).toBe('Open the file and save it.');
  });
});

describe('removeFillers: leftovers', () => {
  it('leaves no double space around spaced commas', () => {
    expect(removeFillers('x , um , y')).toBe('x y');
  });
  it('leaves no comma at the end of a line', () => {
    expect(removeFillers('Apples, um\nnext line')).toBe('Apples\nnext line');
    expect(removeFillers('Apples, um')).toBe('Apples');
  });
  it('leaves no comma before the end of the text', () => {
    expect(removeFillers('One, two, um')).toBe('One, two');
  });
});

describe('removeFillers: capitals', () => {
  it('does not capitalize after an abbreviation', () => {
    expect(removeFillers('We left at 3 p.m. um we left.')).toBe('We left at 3 p.m. we left.');
    expect(removeFillers('The U.S. uh policy changed.')).toBe('The U.S. policy changed.');
    expect(removeFillers('Ask Dr. um Smith.')).toBe('Ask Dr. Smith.');
  });
  it('does not capitalize after an ellipsis', () => {
    expect(removeFillers('Hello\u2026 um, yes.')).toBe('Hello\u2026 yes.');
    expect(removeFillers('Hello... um, yes.')).toBe('Hello... yes.');
  });
  it('capitalizes the first word when a sentence starts with a stretched Hmm', () => {
    expect(removeFillers('Hmm... let me think.')).toBe('Let me think.');
    expect(removeFillers('Okay. hmm... yes.')).toBe('Okay. Yes.');
    expect(removeFillers('Hmm\u2026 let me think.')).toBe('Let me think.');
  });
  it('still capitalizes after a plain full stop', () => {
    expect(removeFillers('Done. Um, next.')).toBe('Done. Next.');
  });
});

describe('removeFillers: uh huh', () => {
  it.each([
    'She said uh, huh? and left.',
    'She said uh,huh and left.',
    'She said uh huh and left.',
    'She said uh-huh and left.',
    'She said um , huh and left.',
  ])('leaves alone: %s', (text) => {
    expect(removeFillers(text)).toBe(text);
  });
});

describe('removeFillers: names in the middle of a sentence', () => {
  it('keeps a capitalized filler that is not at the start of a sentence', () => {
    expect(removeFillers('The Um Kulthum song is old.')).toBe('The Um Kulthum song is old.');
    expect(removeFillers('We met Ah Beng today.')).toBe('We met Ah Beng today.');
  });
  it('removes a capitalized filler that starts a sentence', () => {
    expect(removeFillers('Done. Um Kulthum sang.')).toBe('Done. Kulthum sang.');
  });
  it('removes a lowercase filler in the middle of a sentence', () => {
    expect(removeFillers('We met um Beng today.')).toBe('We met Beng today.');
  });
  it('removes a capitalized filler that follows another filler', () => {
    expect(removeFillers('Um, Uh, the build failed.')).toBe('The build failed.');
  });
});

describe('removeFillers: run time', () => {
  it('handles a very long run of spaces in linear time', () => {
    const t0 = Date.now();
    const out = removeFillers(' '.repeat(200000) + 'word um');
    expect(out.endsWith('word')).toBe(true);
    expect(Date.now() - t0).toBeLessThan(500);
  });
  it('removes every filler from a long text, with no cap', () => {
    const t0 = Date.now();
    const out = removeFillers('word, um, '.repeat(30000));
    expect(/\bum\b/.test(out)).toBe(false);
    expect(out.startsWith('word word')).toBe(true);
    expect(Date.now() - t0).toBeLessThan(1500);
  });
  it('handles a long text with no stops', () => {
    const t0 = Date.now();
    const out = removeFillers('alpha beta um '.repeat(20000));
    expect(/\bum\b/.test(out)).toBe(false);
    expect(Date.now() - t0).toBeLessThan(1500);
  });
});

describe('removeFillers: review round 2', () => {
  it.each([
    'The ( um ) value.',
    'A [ uh ] test.',
    'one - um - two',
    'Say " um " now.',
    'Run ` um ` now.',
  ])('leaves a filler wrapped with spaces alone: %s', (text) => {
    expect(removeFillers(text)).toBe(text);
  });
  it('still removes a filler that only follows a closing quote or bracket', () => {
    expect(removeFillers('He said "hello" um and left.')).toBe('He said "hello" and left.');
    expect(removeFillers('The (old) um value.')).toBe('The (old) value.');
  });

  it('capitalizes the next word when the filler ends a sentence with a stop', () => {
    expect(removeFillers('We go um! now.')).toBe('We go! Now.');
    expect(removeFillers('Is it done, um? yes.')).toBe('Is it done? Yes.');
    expect(removeFillers('We ship Friday, um. then we rest.')).toBe('We ship Friday. Then we rest.');
  });
  it('does not capitalize after an ellipsis that the filler ended', () => {
    expect(removeFillers('We go um... now.')).toBe('We go... now.');
  });
  it('keeps one ellipsis when the kept text already ends in one', () => {
    expect(removeFillers('I was... uh... thinking.')).toBe('I was... thinking.');
    expect(removeFillers('I was\u2026 uh\u2026 thinking.')).toBe('I was\u2026 thinking.');
  });

  it('leaves one space when a consumed comma had extra spaces after it', () => {
    expect(removeFillers('We go, um,  now.')).toBe('We go now.');
    expect(removeFillers('I am, um, \tready.')).toBe('I am ready.');
    expect(removeFillers('We go um   now.')).toBe('We go now.');
  });

  it('removes a capitalized filler that starts a sentence after an abbreviation', () => {
    expect(removeFillers('We left at 3 p.m. Um, then we ate.')).toBe('We left at 3 p.m. then we ate.');
    expect(removeFillers('In the U.S. Uh, it is fine.')).toBe('In the U.S. it is fine.');
  });

  it('handles a filler followed by a very long run of spaces in linear time', () => {
    const t0 = Date.now();
    const a = removeFillers('a um' + ' '.repeat(100000) + 'x um y');
    expect(a).toBe('a x y');
    const b = removeFillers('um' + ' '.repeat(20000) + 'Word Um '.repeat(2000));
    expect(b.startsWith('Word Um Word Um')).toBe(true);
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});

describe('shouldCleanLanguage', () => {
  it('cleans when the provider reports English in any common form', () => {
    for (const l of ['en', 'en_us', 'en-GB', 'english', 'English', 'eng', 'EN']) {
      expect(shouldCleanLanguage(undefined, l)).toBe(true);
    }
  });
  it('cleans when the provider reports nothing but the caller asked for English', () => {
    expect(shouldCleanLanguage('en', undefined)).toBe(true);
    expect(shouldCleanLanguage('en-US', undefined)).toBe(true);
  });
  it('leaves the text alone when no language is known', () => {
    expect(shouldCleanLanguage(undefined, undefined)).toBe(false);
    expect(shouldCleanLanguage('', '')).toBe(false);
  });
  it('leaves the text alone for any other language, even when the caller asked for English', () => {
    expect(shouldCleanLanguage('de', undefined)).toBe(false);
    expect(shouldCleanLanguage(undefined, 'german')).toBe(false);
    expect(shouldCleanLanguage('en', 'de')).toBe(false);
    expect(shouldCleanLanguage(undefined, 'enm_other')).toBe(false);
  });
});
