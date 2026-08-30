import { describe, expect, it, vi } from 'vitest';
import {
  protectedTermsFor,
  sanitizeForSpeech,
  type LatinLeak,
} from './sanitize.js';

describe('markdown stripping', () => {
  it('strips the bullets and bold a model reaches for when listing options', () => {
    const raw = 'Значи закажувам:\n- **Стоматолошки преглед**\n- *Утре во десет*\n\nДали потврдувате?';
    expect(sanitizeForSpeech(raw, { language: 'mk' })).toBe(
      'Значи закажувам: Стоматолошки преглед Утре во десет Дали потврдувате?',
    );
  });

  it('leaves ordinary Macedonian untouched', () => {
    const plain = 'Слободно е утре во десет и половина наутро. Да го закажам?';
    expect(sanitizeForSpeech(plain, { language: 'mk' })).toBe(plain);
  });
});

describe('Latin script inside Macedonian', () => {
  // Confirmed through mk-MK-AleksandarNeural: the Latin token is audibly
  // wrong, the Cyrillic name beside it reads correctly.
  const LEAKED = 'Во ред, закажано на ime Димитар Куцулов.';

  it('transliterates an allowlisted leak', () => {
    expect(sanitizeForSpeech(LEAKED, { language: 'mk' })).toBe(
      'Во ред, закажано на име Димитар Куцулов.',
    );
  });

  it('converts the leak but never the business name beside it', () => {
    // The case that rules out a blanket Latin -> Cyrillic pass.
    const reply = 'Во ред, закажано на ime Димитар во Smile Studio Ohrid.';
    const out = sanitizeForSpeech(reply, {
      language: 'mk',
      protectedTerms: ['Smile Studio Ohrid'],
    });

    expect(out).toContain('на име Димитар');
    expect(out).toContain('Smile Studio Ohrid');
    expect(out).not.toContain('ime');
  });

  it('protects a proper noun even when it collides with the allowlist', () => {
    const out = sanitizeForSpeech('Добредојдовте во ime Clinic.', {
      language: 'mk',
      protectedTerms: ['ime Clinic'],
    });
    expect(out).toBe('Добредојдовте во ime Clinic.');
  });

  it('preserves capitalisation when transliterating', () => {
    expect(sanitizeForSpeech('Ime Димитар.', { language: 'mk' })).toBe('Име Димитар.');
    expect(sanitizeForSpeech('IME Димитар.', { language: 'mk' })).toBe('ИМЕ Димитар.');
  });

  it('reports every Latin token with the full reply, converted or not', () => {
    const onLatinLeak = vi.fn<(leak: LatinLeak) => void>();
    sanitizeForSpeech('Закажано на ime Димитар, doktor Ана.', {
      language: 'mk',
      onLatinLeak,
    });

    expect(onLatinLeak).toHaveBeenCalledOnce();
    const leak = onLatinLeak.mock.calls[0]![0];
    expect(leak.converted).toEqual(['ime']);
    // "doktor" is not in the allowlist: left alone, but surfaced so the
    // dictionary can be extended from real evidence rather than guesses.
    expect(leak.unconverted).toEqual(['doktor']);
    expect(leak.reply).toContain('Закажано на ime');
  });

  it('says nothing when the reply is clean', () => {
    const onLatinLeak = vi.fn();
    sanitizeForSpeech('Закажано на име Димитар.', { language: 'mk', onLatinLeak });
    expect(onLatinLeak).not.toHaveBeenCalled();
  });

  it('leaves English and Albanian replies entirely alone', () => {
    const english = 'Your appointment is booked for tomorrow at half past ten.';
    expect(sanitizeForSpeech(english, { language: 'en' })).toBe(english);

    const albanian = 'Termini u rezervua për nesër në orën dhjetë e gjysmë.';
    expect(sanitizeForSpeech(albanian, { language: 'sq' })).toBe(albanian);
  });

  /**
   * The specific collision, because `ime` is not only a Macedonian leak — it
   * is an ordinary Albanian word meaning "my".
   *
   * The only thing keeping the transliteration away from it is the `mk` gate,
   * and an Albanian reply DOES contain Cyrillic in practice: the clinic is
   * called Дентал Охрид, so the `CYRILLIC.test` short-circuit does not save
   * it either. Measured before this test existed: with the language omitted,
   * "është ime" came back "është име" and would have been read aloud in
   * Cyrillic by an Albanian voice.
   */
  it('never transliterates an Albanian word that collides with the allowlist', () => {
    const albanian = 'Termini imë te Дентал Охрид është ime, në orën dhjetë.';
    expect(sanitizeForSpeech(albanian, { language: 'sq' })).toBe(albanian);
    expect(sanitizeForSpeech(albanian, { language: 'sq' })).toContain('ime');
    expect(sanitizeForSpeech(albanian, { language: 'sq' })).not.toContain('име');
  });

  it('leaves Albanian diacritics untouched', () => {
    // ë and ç are outside IS_LATIN_WORD's A-Za-z, so a word containing them
    // would not even be seen as a Latin token. Pinned so a "helpful" widening
    // of that pattern has to break a test first.
    const albanian = 'Mirë se erdhët. Çfarë dite ju përshtatet, të mërkurën apo të enjten?';
    expect(sanitizeForSpeech(albanian, { language: 'sq' })).toBe(albanian);
  });

  it('does not spell out numerals in Albanian, where cardinals are correct', () => {
    // Macedonian needs "26" -> "дваесет и шести" because a date takes an
    // ordinal. Albanian dates take the cardinal, so the numeral is already
    // right and rewriting it would be the bug.
    const albanian = 'Termini është më 26 gusht, në orën 10.';
    expect(sanitizeForSpeech(albanian, { language: 'sq' })).toBe(albanian);
  });
});

describe('protectedTermsFor', () => {
  it('collects the clinic, its staff and every service name', () => {
    const terms = protectedTermsFor({
      business: { name: 'Дентал Охрид' },
      services: [{ nameMk: 'Преглед', nameSq: 'Kontroll', nameEn: 'Dental check-up' }],
      staff: [{ name: 'д-р Ана Смилевска' }],
    });
    expect(terms).toContain('Дентал Охрид');
    expect(terms).toContain('Dental check-up');
    expect(terms).toContain('д-р Ана Смилевска');
  });
});

describe('numeral dates', () => {
  it('spells out a day the model wrote as a digit', () => {
    // speakDate already produces words, and the prompt forbids digits, but the
    // model writes dates itself often enough — and "26 август" is read aloud
    // as a cardinal, which is wrong and audible.
    expect(sanitizeForSpeech('Закажано за 26 август во десет.', { language: 'mk' })).toContain(
      'дваесет и шести август',
    );
    expect(sanitizeForSpeech('во 3 септември', { language: 'mk' })).toContain('трети септември');
    expect(sanitizeForSpeech('1. јануари', { language: 'mk' })).toContain('први јануари');
  });

  it('leaves numbers that are not dates alone', () => {
    // Prices and durations survive untouched: they are read correctly as
    // cardinals already, and spelling them out would sound absurd.
    expect(sanitizeForSpeech('Цената е 1500 денари.', { language: 'mk' })).toContain('1500 денари');
    expect(sanitizeForSpeech('Трае 45 минути.', { language: 'mk' })).toContain('45 минути');
    /**
     * A phone number is the exception, and deliberately so — this assertion
     * used to require the digits to survive. Azure reads "070 111 222" as
     * three cardinals, and a caller checking their own number against
     * "seventy, one hundred eleven, two hundred twenty two" has to do
     * arithmetic before they can agree with it.
     */
    expect(sanitizeForSpeech('Бројот е 070 111 222.', { language: 'mk' })).toContain(
      'нула седум нула, еден еден еден, два два два',
    );
  });

  it('leaves an impossible day alone rather than inventing an ordinal', () => {
    expect(sanitizeForSpeech('верзија 99 август', { language: 'mk' })).toContain('99 август');
  });
});

describe('titles a synthesizer would spell out letter by letter', () => {
  it('says "доктор" for the written abbreviation', () => {
    /**
     * The clinic's own staff rows store "д-р Ана Смилевска", so this fires on
     * most bookings. Azure reads the abbreviation as letters, hyphen included.
     */
    expect(sanitizeForSpeech('Закажано кај д-р Ана Смилевска.', { language: 'mk' })).toBe(
      'Закажано кај доктор Ана Смилевска.',
    );
  });

  it('handles the variants a human types', () => {
    for (const written of ['д-р', 'др.', 'Д-Р', 'д.р']) {
      expect(sanitizeForSpeech(`Кај ${written} Ана.`, { language: 'mk' })).toContain('доктор Ана');
    }
  });

  it('leaves ordinary words that merely start with those letters alone', () => {
    // "другар", "дрво" — a naive replace would maul both.
    const text = 'Другар ми рече дека дрвото е таму.';
    expect(sanitizeForSpeech(text, { language: 'mk' })).toBe(text);
  });

  it('expands the Albanian and English titles too', () => {
    expect(sanitizeForSpeech('Me Dr. Ana.', { language: 'sq' })).toBe('Me doktor Ana.');
    expect(sanitizeForSpeech('With Dr. Ana.', { language: 'en' })).toBe('With doctor Ana.');
  });
});

describe('phone numbers are digits, never a cardinal', () => {
  it('spells a bare number the model wrote out', () => {
    /**
     * The floor beneath the prompt. Azure reads "070123456" as a single
     * enormous cardinal; a caller cannot check their own number against that.
     */
    expect(sanitizeForSpeech('Бројот е 070123456.', { language: 'mk' })).toBe(
      'Бројот е нула седум нула, еден два три, четири пет шест.',
    );
  });

  it('leaves prices, durations and years alone', () => {
    // Six digits is the shortest thing that must never be read as a number;
    // everything below is read correctly as a cardinal already.
    const text = 'Прегледот трае 30 минути и чини 1500 денари, во 2026 година.';
    expect(sanitizeForSpeech(text, { language: 'mk' })).toBe(text);
  });
});
