import { listBusinesses, renderGreeting, type Business, type Database } from '@frontly/core';
import { DEFAULT_VOICE_CONFIG, type Language } from '@frontly/shared';
import { cacheablePhrases } from './phrases.js';
import { phraseRequest, type SpeechCache } from './speech-cache.js';

/**
 * Fill the speech cache before anyone calls.
 *
 * Warming lazily on the first call would mean the first caller of the day —
 * on a free Render instance, quite possibly the person demoing this on stage —
 * pays every cost the cache exists to remove. So it runs at boot, in the
 * background, and the server serves traffic while it finishes.
 */

export interface WarmResult {
  warmed: number;
  failed: number;
  languages: Language[];
}

/** Every fixed line this business can say, in every language it answers in. */
export function warmRequests(business: Business) {
  const languages = (business.languages.length > 0 ? business.languages : ['mk']) as Language[];
  const greeting = renderGreeting(business);

  return languages.flatMap((language) => {
    const profile = business.voiceConfig?.[language] ?? DEFAULT_VOICE_CONFIG[language];
    return [
      // The greeting carries the pause between sentence and question, so it
      // must be warmed with the same flag the session will ask for — a
      // mismatch here is a cache that silently never hits.
      phraseRequest(greeting, language, profile, { breakAfterFirstSentence: true }),
      ...cacheablePhrases(language).map((text) => phraseRequest(text, language, profile)),
    ];
  });
}

export async function warmBusiness(cache: SpeechCache, business: Business): Promise<WarmResult> {
  const requests = warmRequests(business);
  const { warmed, failed } = await cache.warmAll(requests);
  return {
    warmed,
    failed,
    languages: (business.languages.length > 0 ? business.languages : ['mk']) as Language[],
  };
}

/** Warm every business this deployment answers for. */
export async function warmAllBusinesses(
  cache: SpeechCache,
  db: Database,
): Promise<{ businesses: number; warmed: number; failed: number }> {
  const all = await listBusinesses(db);
  const results = await Promise.all(all.map((business) => warmBusiness(cache, business)));
  return {
    businesses: all.length,
    warmed: results.reduce((sum, r) => sum + r.warmed, 0),
    failed: results.reduce((sum, r) => sum + r.failed, 0),
  };
}
