import { describe, expect, it, vi } from 'vitest';
import {
  protectedTermsFor,
  sanitizeForSpeech,
  type LatinLeak,
} from './sanitize.js';

describe('markdown stripping', () => {
  it('strips the bullets and bold a model reaches for when listing options', () => {
    const raw = 'Значи закажувам:\n- **Стоматолошки преглед**\n- *Утре во десет*\n\nДали потврдувате?';
    expect(sanitizeForSpeech(raw)).toBe(
      'Значи закажувам: Стоматолошки преглед Утре во десет Дали потврдувате?',
    );
  });

  it('leaves ordinary Macedonian untouched', () => {
    const plain = 'Слободно е утре во десет и половина наутро. Да го закажам?';
    expect(sanitizeForSpeech(plain)).toBe(plain);
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
    // Prices, durations and phone numbers must survive untouched.
    expect(sanitizeForSpeech('Цената е 1500 денари.', { language: 'mk' })).toContain('1500 денари');
    expect(sanitizeForSpeech('Трае 45 минути.', { language: 'mk' })).toContain('45 минути');
    expect(sanitizeForSpeech('Бројот е 070 111 222.', { language: 'mk' })).toContain('070 111 222');
  });

  it('leaves an impossible day alone rather than inventing an ordinal', () => {
    expect(sanitizeForSpeech('верзија 99 август', { language: 'mk' })).toContain('99 август');
  });
});
