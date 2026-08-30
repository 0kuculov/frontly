'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Keep the page current without anyone pressing anything.
 *
 * The demo is a phone call: someone rings the number, books, and then looks at
 * this screen. If the booking is only there after a manual reload, the reload
 * is the thing the room watches — so the page refetches on its own.
 *
 * `router.refresh()` re-runs the server components and nothing else. It is not
 * a page load: no flash, no lost scroll position, and client state survives.
 * Every dashboard route is `force-dynamic` and every fetch is `no-store`, so a
 * refresh genuinely re-reads the database rather than a cache.
 *
 * Deliberately NOT a socket. The demo screen has one because it renders a call
 * as it happens, turn by turn; this page shows a day, which changes when a call
 * finishes. Polling a few times a minute is the right size for that, and it
 * costs one API request against an endpoint the page already calls.
 *
 * Two rules keep it cheap:
 *  - a hidden tab does nothing. A dashboard left open on a spare monitor
 *    overnight should not spend the night querying Turso.
 *  - coming back to the tab refreshes immediately, because that is exactly the
 *    moment someone wants to see what the call did — waiting out the rest of
 *    an interval in front of the room is the failure this exists to avoid.
 */
export function AutoRefresh({ everyMs = 20_000 }: { everyMs?: number }) {
  const router = useRouter();

  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === 'visible') router.refresh();
    };

    const timer = setInterval(refresh, everyMs);
    // `visibilitychange` covers switching tabs; `focus` covers switching
    // windows, which on a demo laptop is the more likely of the two.
    document.addEventListener('visibilitychange', refresh);
    window.addEventListener('focus', refresh);

    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', refresh);
      window.removeEventListener('focus', refresh);
    };
  }, [router, everyMs]);

  return null;
}
