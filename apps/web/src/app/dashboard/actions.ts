'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { apiPatch } from '../../lib/api';
import { clearSession, setLang, type Lang } from '../../lib/session';

/** Sign out. The API token simply expires; forgetting it here is the logout. */
export async function signOut(): Promise<void> {
  await clearSession();
  redirect('/login');
}

export async function switchLanguage(lang: Lang): Promise<void> {
  await setLang(lang);
  // Every page is server-rendered in one language, so a switch has to re-render
  // the whole tree rather than swapping strings on the client.
  revalidatePath('/', 'layout');
}

export interface SaveState {
  status: 'idle' | 'ok' | 'error';
  error?: string;
}

/**
 * Save the clinic settings.
 *
 * Only the fields the dashboard owns. `inboundNumber` is deliberately absent —
 * that is the carrier's truth, and a typo there silently unroutes every
 * incoming call — and the API refuses it too, so this is a locked door with a
 * locked door behind it.
 */
export async function saveSettings(
  _previous: SaveState,
  formData: FormData,
): Promise<SaveState> {
  const languages = formData.getAll('languages').map(String).filter(Boolean);

  const body: Record<string, unknown> = {
    name: String(formData.get('name') ?? '').trim(),
    greetingTemplate: String(formData.get('greetingTemplate') ?? '').trim(),
    ownerMobile: String(formData.get('ownerMobile') ?? '').trim(),
  };
  if (languages.length > 0) body.languages = languages;

  const result = await apiPatch('/dashboard/settings', body);
  if (!result.ok) return { status: 'error', ...(result.error ? { error: result.error } : {}) };

  revalidatePath('/dashboard/settings');
  return { status: 'ok' };
}
