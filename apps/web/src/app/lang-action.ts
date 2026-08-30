'use server';

import { revalidatePath } from 'next/cache';
import { setLang } from '../lib/session';
import type { Lang } from '../lib/lang';

/**
 * Switch the language for everything, signed in or not.
 *
 * Its own file rather than living in the dashboard's actions: the landing page
 * needs it too, and the landing page is what somebody sees BEFORE they have an
 * account. A server action importable from `dashboard/` would have made the
 * marketing page depend on the authenticated half of the app.
 *
 * The cookie is the only state. Every page is server-rendered in one language,
 * so a switch has to re-render the tree rather than swap strings on the client
 * — which is also why this revalidates the root layout rather than one path.
 */
export async function switchLanguage(lang: Lang): Promise<void> {
  await setLang(lang);
  revalidatePath('/', 'layout');
}
