import { redirect } from 'next/navigation';
import { getSessionToken } from './session';

/**
 * Talking to the API.
 *
 * The dashboard is a client of the API rather than a second copy of it — every
 * read goes over HTTP so this deployment and Render can never disagree about
 * the data, and the database credentials stay on exactly one machine. That
 * decision predates Phase 4; it is why there is no drizzle in this app.
 */

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8080';

export interface DashboardAppointment {
  id: string;
  startsAt: string;
  endsAt: string;
  customerName: string;
  customerPhone: string;
  status: string;
  channel: string;
  serviceName: string;
  serviceDurationMinutes: number;
  staffName: string;
  staffId: string;
  confirmationSentAt: string | null;
  reminderSentAt: string | null;
}

export interface DashboardConversation {
  id: string;
  channel: string;
  externalId: string;
  startedAt: string;
  endedAt: string | null;
  outcome: string | null;
  languageDetected: string | null;
  fromIdentifier: string | null;
  durationMs: number | null;
  avgCallerFacingMs: number | null;
  turnCount: number;
  appointmentId: string | null;
}

export interface TranscriptTurn {
  role: string;
  text: string;
  atMs: number;
  callerFacingMs?: number;
  toolCalls?: { name: string; input?: unknown; output?: unknown; durationMs?: number }[];
}

export interface TodayResponse {
  business: { name: string; timezone: string };
  day: { startsAt: string; endsAt: string };
  appointments: DashboardAppointment[];
  conversations: DashboardConversation[];
  counts: { appointments: number; conversations: number; booked: number; transferred: number };
  /**
   * Both optional, and deliberately so: Vercel and Render deploy separately,
   * so a page can be newer than the API answering it. Typing them as always
   * present is how that window becomes a white screen.
   */
  upcoming?: DashboardAppointment[];
  bookedByCalls?: { id: string; startsAt: string; status: string }[];
}

export interface CalendarService {
  id: string;
  name: string;
  durationMinutes: number;
}

export interface CalendarStaff {
  id: string;
  name: string;
  serviceIds: string[];
}

export interface FreeSlot {
  staffId: string;
  staffName: string;
  startsAt: string;
  endsAt: string;
}

export interface SettingsResponse {
  business: {
    id: string;
    name: string;
    timezone: string;
    languages: string[];
    greetingTemplate: string;
    ownerMobile: string | null;
    workingHours: Record<string, { start: string; end: string }[]>;
    inboundNumber: string | null;
  };
  services: {
    id: string;
    nameMk: string;
    durationMinutes: number;
    price: number | null;
    currency: string;
    active: boolean;
  }[];
  staff: { id: string; name: string; active: boolean; serviceIds: string[] }[];
}

/**
 * A GET that requires a session.
 *
 * A 401 redirects to the login rather than throwing: the token expires after
 * twelve hours, so "your session ended" is a normal Tuesday, not an error
 * worth an error screen.
 */
export async function apiGet<T>(path: string): Promise<T> {
  const token = await getSessionToken();
  if (!token) redirect('/login');

  const response = await fetch(`${API}${path}`, {
    headers: { authorization: `Bearer ${token}` },
    // Always fresh. A dashboard showing yesterday's day is worse than a slow one.
    cache: 'no-store',
  });

  if (response.status === 401) redirect('/login');
  if (!response.ok) {
    throw new Error(`API ${path} failed: ${response.status}`);
  }
  return (await response.json()) as T;
}

/**
 * A POST that requires a session.
 *
 * Returns the parsed body on success and the API's own error code on failure,
 * because every booking failure is a different sentence to show a person:
 * `slot_taken` means pick another time, `outside_working_hours` means the
 * clinic is shut, `invalid_input` means a field is wrong. Collapsing them into
 * "something went wrong" would throw away the only useful part.
 */
export async function apiPost<T>(
  path: string,
  body?: unknown,
): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  const token = await getSessionToken();
  if (!token) redirect('/login');

  const response = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    cache: 'no-store',
  });

  if (response.status === 401) redirect('/login');
  if (!response.ok) {
    const detail = (await response.json().catch(() => ({}))) as { error?: string };
    return { ok: false, error: detail.error ?? `http_${response.status}` };
  }
  return { ok: true, data: (await response.json()) as T };
}

export async function apiPatch(
  path: string,
  body: unknown,
): Promise<{ ok: boolean; error?: string }> {
  const token = await getSessionToken();
  if (!token) redirect('/login');

  const response = await fetch(`${API}${path}`, {
    method: 'PATCH',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (response.status === 401) redirect('/login');
  if (!response.ok) {
    const detail = (await response.json().catch(() => ({}))) as { error?: string };
    return { ok: false, error: detail.error ?? `http_${response.status}` };
  }
  return { ok: true };
}

export async function apiLogin(
  email: string,
  password: string,
): Promise<{ token: string } | { error: 'invalid_credentials' | 'api_unreachable' }> {
  let response: Response;
  try {
    response = await fetch(`${API}/dashboard/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
      cache: 'no-store',
    });
  } catch {
    /**
     * The API is not answering at all — not running, wrong port, wrong host.
     *
     * Reported separately from a rejected password because they are not the
     * same problem and do not have the same fix. This used to throw, so a
     * stopped API produced an unhandled exception that looked exactly like bad
     * credentials, and the owner would go and reset a password that was never
     * wrong.
     */
    return { error: 'api_unreachable' };
  }

  if (!response.ok) {
    return { error: 'invalid_credentials' };
  }
  return (await response.json()) as { token: string };
}
