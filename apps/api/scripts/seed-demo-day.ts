/**
 * A realistic demo day, in a scratch database.
 *
 * Design work needs content: an empty dashboard tells you nothing about
 * whether a layout holds, and the production clinic's data is reset whenever
 * somebody presses the button on the stage screen. This writes a plausible
 * Tuesday — a few appointments across the day, a few calls with transcripts,
 * one of each outcome — so screens can be judged with something in them.
 *
 * Refuses to touch anything but a `file:` database. It writes appointments and
 * conversations directly, which is exactly the kind of script that must never
 * be pointed at Turso by accident:
 *
 *   DATABASE_URL=file:./scratch.db pnpm --filter @frontly/api seed:demo-day
 */
import {
  appointments,
  conversations,
  createDb,
  DEMO_IDS,
  newId,
  startOfZonedDay,
  toZonedParts,
} from '@frontly/core';
import { loadEnv } from '@frontly/shared';

const env = loadEnv();

if (!env.DATABASE_URL.startsWith('file:')) {
  console.error(
    `\n  Refusing to seed ${env.DATABASE_URL}.\n` +
      '  This script writes appointments and conversations directly, so it only\n' +
      '  ever runs against a local file: database. Set DATABASE_URL=file:./scratch.db\n',
  );
  process.exit(1);
}

const db = createDb({ url: env.DATABASE_URL });
const TZ = 'Europe/Skopje';

/** An instant at a wall-clock hour on a day N days from today, in the clinic's zone. */
function at(daysAhead: number, hour: number, minute = 0): Date {
  const now = new Date();
  const parts = toZonedParts(new Date(now.getTime() + daysAhead * 86_400_000), TZ);
  const midnight = startOfZonedDay(TZ, parts.year, parts.month, parts.day);
  return new Date(midnight.getTime() + (hour * 60 + minute) * 60_000);
}

interface Booking {
  daysAhead: number;
  hour: number;
  minute?: number;
  name: string;
  phone: string;
  service: keyof typeof DEMO_IDS.services;
  staff: keyof typeof DEMO_IDS.staff;
  minutes: number;
}

const BOOKINGS: Booking[] = [
  { daysAhead: 0, hour: 9, name: 'Марко Петровски', phone: '+38970111222', service: 'checkup', staff: 'ana', minutes: 30 },
  { daysAhead: 0, hour: 10, minute: 30, name: 'Елена Трајкова', phone: '+38975332211', service: 'cleaning', staff: 'ana', minutes: 45 },
  { daysAhead: 0, hour: 14, name: 'Стефан Јованов', phone: '+38977884411', service: 'filling', staff: 'stefan', minutes: 60 },
  { daysAhead: 0, hour: 16, name: 'Ана Кировска', phone: '+38970556677', service: 'checkup', staff: 'stefan', minutes: 30 },
  { daysAhead: 1, hour: 9, minute: 30, name: 'Дарко Ристовски', phone: '+38978220044', service: 'checkup', staff: 'ana', minutes: 30 },
  { daysAhead: 2, hour: 11, name: 'Билјана Стојанова', phone: '+38971443322', service: 'cleaning', staff: 'ana', minutes: 45 },
];

const TRANSCRIPT = [
  { role: 'customer', text: 'Добар ден, сакам да закажам стоматолошки преглед.', atMs: 4200, confidence: 0.91 },
  { role: 'agent', text: 'Добар ден. За кој датум и приближно време би сакале?', atMs: 6100 },
  { role: 'customer', text: 'Утре наутро, ако може.', atMs: 15400, confidence: 0.88 },
  {
    role: 'agent',
    text: 'Имаме слободно утре во девет и половина наутро, кај доктор Ана Смилевска. Дали ви одговара?',
    atMs: 18900,
    toolCalls: [{ name: 'check_availability', durationMs: 11 }],
  },
  { role: 'customer', text: 'Да, одлично.', atMs: 27300, confidence: 0.94 },
  {
    role: 'agent',
    text: 'Ве запишав како Дарко Ристовски, на бројот нула седум осум, два два нула, нула четири четири. Точно?',
    atMs: 31200,
    toolCalls: [{ name: 'confirm_details', durationMs: 6 }],
  },
  { role: 'customer', text: 'Точно е.', atMs: 40100, confidence: 0.9 },
  {
    role: 'agent',
    text: 'Готово, терминот е закажан. Ќе добиете потврда со порака. Има ли нешто друго?',
    atMs: 43800,
    toolCalls: [{ name: 'book_appointment', durationMs: 44 }],
  },
  { role: 'customer', text: 'Не, благодарам.', atMs: 51500, confidence: 0.93 },
  { role: 'agent', text: 'Ви благодарам што се јавивте. Пријатен ден.', atMs: 52100, toolCalls: [{ name: 'end_call' }] },
];

async function main(): Promise<void> {
  await db.delete(appointments);
  await db.delete(conversations);

  const created: string[] = [];
  for (const b of BOOKINGS) {
    const id = newId('appointment');
    const startsAt = at(b.daysAhead, b.hour, b.minute ?? 0);
    await db.insert(appointments).values({
      id,
      businessId: DEMO_IDS.business,
      serviceId: DEMO_IDS.services[b.service],
      staffId: DEMO_IDS.staff[b.staff],
      customerName: b.name,
      customerPhone: b.phone,
      startsAt,
      endsAt: new Date(startsAt.getTime() + b.minutes * 60_000),
      status: 'booked',
      channel: 'voice',
    });
    created.push(id);
  }

  /** One conversation per outcome, so every badge on the screen is real. */
  const calls: { outcome: string; minutesAgo: number; turns: number; appointmentId?: string }[] = [
    { outcome: 'booked', minutesAgo: 55, turns: 10, appointmentId: created[4]! },
    { outcome: 'booked', minutesAgo: 180, turns: 10, appointmentId: created[5]! },
    { outcome: 'info', minutesAgo: 240, turns: 4 },
    { outcome: 'transferred', minutesAgo: 320, turns: 6 },
    { outcome: 'abandoned', minutesAgo: 400, turns: 1 },
  ];

  for (const call of calls) {
    const startedAt = new Date(Date.now() - call.minutesAgo * 60_000);
    const transcript = TRANSCRIPT.slice(0, call.turns).map((turn, index) => ({
      ...turn,
      ...(turn.role === 'agent' ? { callerFacingMs: 1200 + index * 90 } : {}),
    }));
    await db.insert(conversations).values({
      id: newId('conversation'),
      businessId: DEMO_IDS.business,
      channel: 'voice',
      externalId: `scratch:${newId('conversation')}`,
      fromIdentifier: '+38970111222',
      startedAt,
      endedAt: new Date(startedAt.getTime() + 60_000 + call.turns * 5_000),
      languageDetected: 'mk',
      outcome: call.outcome as 'booked',
      transcript: transcript as never,
      appointmentId: call.appointmentId ?? null,
    });
  }

  console.log(`\n  ${created.length} appointments, ${calls.length} conversations`);
  console.log(`  database : ${env.DATABASE_URL}\n`);
}

await main();
