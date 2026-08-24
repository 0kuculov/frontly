import { describe, expect, it } from 'vitest';
import { SentenceSplitter, splitSentences } from './sentences.js';

describe('splitting streamed text into speakable sentences', () => {
  it('yields a sentence as soon as it is terminated', () => {
    const s = new SentenceSplitter();
    expect(s.push('Слободно е утре во десет')).toEqual([]);
    expect(s.push(' и половина наутро. ')).toEqual(['Слободно е утре во десет и половина наутро.']);
    // The second sentence is still being written.
    expect(s.push('Да го закажам')).toEqual([]);
    expect(s.flush()).toBe('Да го закажам');
  });

  it('does not cut on a full stop that is still mid-stream', () => {
    // A boundary needs whitespace after it, or it might be a decimal.
    const s = new SentenceSplitter();
    expect(s.push('Цената е 1.')).toEqual([]);
    expect(s.push('500 денари сega.')).toEqual([]);
    expect(s.push(' ')).toEqual(['Цената е 1.500 денари сega.']);
  });

  it('keeps a run of punctuation together', () => {
    expect(splitSentences('Навистина?! Одлично, се гледаме утре.')).toEqual([
      'Навистина?!',
      'Одлично, се гледаме утре.',
    ]);
  });

  it('does not split on "д-р", which carries no period at all', () => {
    expect(splitSentences('Кај д-р Ана Смилевска утре наутро. Добро?')).toEqual([
      'Кај д-р Ана Смилевска утре наутро.',
      'Добро?',
    ]);
  });

  it('does not split after an abbreviation that does end in a period', () => {
    expect(splitSentences('Термин на ул. Партизанска утре. Добро?')).toEqual([
      'Термин на ул. Партизанска утре.',
      'Добро?',
    ]);
  });

  it('keeps short sentences intact rather than merging them', () => {
    // A five-character sentence is still a sentence; merging it delays the
    // audio that the whole streaming design exists to bring forward.
    expect(splitSentences('Прво. Второ. ')).toEqual(['Прво.', 'Второ.']);
  });

  it('handles a whole reply arriving in one delta', () => {
    const s = new SentenceSplitter();
    const out = s.push('Прво. Второ. ');
    expect(out).toEqual(['Прво.', 'Второ.']);
  });

  it('returns nothing from an empty flush', () => {
    expect(new SentenceSplitter().flush()).toBeUndefined();
  });
});
