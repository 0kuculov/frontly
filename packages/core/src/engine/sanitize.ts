/**
 * Make a model reply safe to hand to a speech synthesizer.
 *
 * The prompt already forbids markdown, and the model mostly obeys — but
 * "mostly" is not good enough when the failure mode is Azure reading
 * "ѕвездичка ѕвездичка Преглед" to a caller on stage. Models drift toward
 * bullet lists whenever they enumerate options, which is exactly what a
 * receptionist does all day.
 *
 * So this is a floor, not a substitute for the prompt rule. It runs on every
 * reply, for chat as much as for voice: the widget renders plain text, and one
 * behaviour across channels beats two.
 */
export function sanitizeForSpeech(text: string): string {
  return (
    text
      // Fenced and inline code — never speakable.
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/`([^`]*)`/g, '$1')
      // Emphasis: **bold**, __bold__, then single-marker italics, but only
      // where the marker is not inside a word.
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/__([^_]+)__/g, '$1')
      .replace(/(?<![\p{L}\p{N}])[*_]([^*_\n]+)[*_](?![\p{L}\p{N}])/gu, '$1')
      // Headings and blockquotes.
      .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '')
      .replace(/^[ \t]*>[ \t]?/gm, '')
      // List markers, bulleted and numbered.
      .replace(/^[ \t]*[-*•·]\s+/gm, '')
      .replace(/^[ \t]*\d+[.)]\s+/gm, '')
      // Links: keep the label, drop the target.
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      // Any stray markers the passes above did not pair up.
      .replace(/[*_`]/g, '')
      // A spoken reply is one continuous utterance.
      .replace(/\s*\n+\s*/g, ' ')
      .replace(/[ \t]{2,}/g, ' ')
      .trim()
  );
}
