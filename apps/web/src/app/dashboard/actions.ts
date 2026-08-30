'use server';

import { redirect, unstable_rethrow } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { apiGet, apiPatch, apiPost, type FreeSlot } from '../../lib/api';
import { clearSession } from '../../lib/session';

/** Sign out. The API token simply expires; forgetting it here is the logout. */
export async function signOut(): Promise<void> {
  await clearSession();
  redirect('/login');
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

/**
 * Free times for one service on one day, from the API.
 *
 * A server action rather than a fetch from the browser, for the same reason
 * every other read is one: the session token lives in an httpOnly cookie and
 * is sent to the API by this server. Client JavaScript never sees it, so
 * client JavaScript cannot call the API directly.
 */
export async function loadSlots(input: {
  serviceId: string;
  staffId?: string;
  date: string;
}): Promise<FreeSlot[]> {
  const params = new URLSearchParams({ serviceId: input.serviceId, date: input.date });
  if (input.staffId) params.set('staffId', input.staffId);

  try {
    const data = await apiGet<{ slots: FreeSlot[] }>(`/dashboard/availability?${params}`);
    return data.slots;
  } catch (error) {
    /**
     * `apiGet` signals an expired session by calling `redirect`, which works by
     * throwing. Swallowing that here would leave someone logged out staring at
     * an empty list of times instead of the login page, so it is rethrown
     * before anything else is decided.
     */
    unstable_rethrow(error);
    // Anything else is a rejected query — an unknown service, a malformed date.
    // No times is the honest answer when we could not ask for any.
    return [];
  }
}

export interface BookingResult {
  status: 'idle' | 'ok' | 'error';
  /** The API's own code, so the form can say the right sentence. */
  error?: string;
}

/**
 * Book somebody in from the dashboard.
 *
 * Everything that decides whether this is allowed lives in the API, which runs
 * the same `bookAppointment` the phone does. This function's whole job is to
 * carry the fields across and then make the page re-read itself.
 */
export async function createAppointment(input: {
  serviceId: string;
  staffId: string;
  startsAt: string;
  customerName: string;
  customerPhone: string;
}): Promise<BookingResult> {
  const result = await apiPost('/dashboard/appointments', input);
  if (!result.ok) return { status: 'error', error: result.error };

  revalidatePath('/dashboard');
  revalidatePath('/dashboard/calendar');
  return { status: 'ok' };
}

/** Take somebody off the calendar. Cancels; the record survives. */
export async function cancelAppointment(appointmentId: string): Promise<BookingResult> {
  const result = await apiPost(`/dashboard/appointments/${appointmentId}/cancel`);
  if (!result.ok) return { status: 'error', error: result.error };

  revalidatePath('/dashboard');
  revalidatePath('/dashboard/calendar');
  return { status: 'ok' };
}
