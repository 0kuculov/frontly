/**
 * Cut streamed model text into speakable sentences.
 *
 * This is what turns a 7-second turn into a ~1-second time-to-first-audio: the
 * moment the first sentence is complete, it goes to the synthesizer while the
 * model is still generating the rest. The caller hears speech starting, which
 * is the only latency they actually perceive.
 *
 * Feed it deltas; it yields whole sentences and keeps the remainder buffered.
 */
/**
 * Words that end in a period without ending a sentence.
 *
 * The whitespace rule below already handles decimals ("1.500"), and Macedonian
 * abbreviates doctor as "д-р" with no period at all — so this list is short by
 * design. Extend it from real transcripts, not from imagination.
 */
const ABBREVIATIONS = new Set(['др', 'г', 'г-ѓа', 'проф', 'ул', 'бр', 'сл', 'пр', 'мн']);

export class SentenceSplitter {
  private buffer = '';

  /** Add streamed text; returns any sentences that are now complete. */
  push(delta: string): string[] {
    this.buffer += delta;
    const out: string[] = [];

    for (;;) {
      const cut = this.findBoundary(this.buffer);
      if (cut === -1) break;

      const sentence = this.buffer.slice(0, cut).trim();
      this.buffer = this.buffer.slice(cut);
      if (sentence.length > 0) out.push(sentence);
    }

    return out;
  }

  /** Whatever is left when the stream ends — the final, unterminated clause. */
  flush(): string | undefined {
    const rest = this.buffer.trim();
    this.buffer = '';
    return rest.length > 0 ? rest : undefined;
  }

  /** Index just past a sentence-ending run of punctuation, or -1. */
  private findBoundary(text: string): number {
    for (let i = 0; i < text.length; i++) {
      const char = text[i]!;
      if (char !== '.' && char !== '!' && char !== '?' && char !== '…') continue;

      // Consume a run like "?!" or "..." so it is not split mid-run.
      let end = i;
      while (end + 1 < text.length && '.!?…'.includes(text[end + 1]!)) end++;

      const next = text[end + 1];
      // Still growing — the next delta may extend this run or attach a digit.
      if (next === undefined) return -1;
      // A boundary needs whitespace after it, so "1.500" is not a sentence.
      if (!/\s/.test(next)) {
        i = end;
        continue;
      }
      if (this.endsWithAbbreviation(text.slice(0, i))) {
        i = end;
        continue;
      }

      return end + 1;
    }
    return -1;
  }

  private endsWithAbbreviation(before: string): boolean {
    const lastWord = /([\p{L}\p{M}-]+)$/u.exec(before)?.[1];
    return lastWord !== undefined && ABBREVIATIONS.has(lastWord.toLowerCase());
  }
}

/** One-shot split, for text that is already complete. */
export function splitSentences(text: string): string[] {
  const splitter = new SentenceSplitter();
  const out = splitter.push(text);
  const rest = splitter.flush();
  if (rest) out.push(rest);
  return out;
}
