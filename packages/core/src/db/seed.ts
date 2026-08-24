import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { eq } from 'drizzle-orm';
import {
  emptyWorkingHours,
  weekdayHours,
  DEFAULT_VOICE_CONFIG,
  type Language,
  type WorkingHours,
} from '@frontly/shared';
import { createDb, enableForeignKeys, type Database } from './client.js';
import { loadRootEnv } from './paths.js';
import {
  appointments,
  businesses,
  conversations,
  services,
  staff,
  type NewBusiness,
  type NewService,
  type NewStaffMember,
} from './schema.js';

/**
 * The demo clinic: a dental practice in Ohrid.
 *
 * IDs are fixed rather than generated so that seeding is idempotent and the
 * Phase 7 "reset between demos" button has something stable to aim at. Re-run
 * this as often as you like; it upserts.
 */

export const DEMO_BUSINESS_SLUG = 'dental-ohrid';

export const DEMO_IDS = {
  business: 'biz_demo_dental_ohrid',
  services: {
    checkup: 'svc_demo_pregled',
    cleaning: 'svc_demo_chistenje',
    filling: 'svc_demo_plomba',
  },
  staff: {
    ana: 'stf_demo_ana',
    stefan: 'stf_demo_stefan',
  },
} as const;

/** Mon-Fri 09:00-17:00, Sat 09:00-13:00, closed Sunday. */
const CLINIC_HOURS = weekdayHours(
  [{ start: '09:00', end: '17:00' }],
  [{ start: '09:00', end: '13:00' }],
);

/** Dr Stefan covers afternoons only - useful for exercising slot maths. */
const AFTERNOON_SHIFT: WorkingHours = {
  ...emptyWorkingHours(),
  mon: [{ start: '12:00', end: '17:00' }],
  tue: [{ start: '12:00', end: '17:00' }],
  wed: [{ start: '12:00', end: '17:00' }],
  thu: [{ start: '12:00', end: '17:00' }],
  fri: [{ start: '12:00', end: '17:00' }],
};

export interface SeedOptions {
  /** Wipe this business's appointments and conversations before re-seeding. */
  reset?: boolean;
}

export async function seedDemoBusiness(db: Database, options: SeedOptions = {}): Promise<string> {
  const businessId = DEMO_IDS.business;

  if (options.reset) {
    await db.delete(conversations).where(eq(conversations.businessId, businessId));
    await db.delete(appointments).where(eq(appointments.businessId, businessId));
  }

  const businessValues: NewBusiness = {
    id: businessId,
    name: 'Дентал Охрид',
    slug: DEMO_BUSINESS_SLUG,
    phoneNumber: '+389 46 260 100',
    // Filled in during Phase 3, once a number is bought and assigned.
    inboundNumber: null,
    timezone: 'Europe/Skopje',
    languages: ['mk', 'sq', 'en'] as Language[],
    workingHours: CLINIC_HOURS,
    // First sentence is the greeting, second is the question. The SSML builder
    // drops the configured 300ms pause between them.
    greetingTemplate:
      'Добар ден, се јавивте во {{business_name}}. Како можам да ви помогнам?',
    ownerMobile: '+389 70 260 100',
    brandColor: '#0E7490',
    voiceConfig: DEFAULT_VOICE_CONFIG,
  };

  // inboundNumber is deliberately left out of the update set: Phase 3 assigns a
  // real number and re-seeding must not wipe it.
  const { id: _businessId, inboundNumber: _inboundNumber, ...businessUpdates } = businessValues;

  await db
    .insert(businesses)
    .values(businessValues)
    .onConflictDoUpdate({
      target: businesses.id,
      set: { ...businessUpdates, updatedAt: new Date() },
    });

  const serviceRows: NewService[] = [
    {
      id: DEMO_IDS.services.checkup,
      businessId,
      nameMk: 'Стоматолошки преглед',
      nameSq: 'Kontroll dentar',
      nameEn: 'Dental check-up',
      durationMinutes: 30,
      price: 800,
      currency: 'MKD',
      descriptionMk: 'Општ преглед на забите и непцата, со совет за понатамошна терапија.',
      descriptionSq: 'Kontroll i përgjithshëm i dhëmbëve dhe mishrave të dhëmbëve.',
      descriptionEn: 'General examination of teeth and gums, with treatment advice.',
      sortOrder: 1,
    },
    {
      id: DEMO_IDS.services.cleaning,
      businessId,
      nameMk: 'Чистење на забен камен',
      nameSq: 'Pastrim i gurëzave dentare',
      nameEn: 'Teeth cleaning',
      durationMinutes: 45,
      price: 1500,
      currency: 'MKD',
      descriptionMk: 'Отстранување на забен камен и полирање на забите.',
      descriptionSq: 'Heqja e gurëzave dentare dhe lustrimi i dhëmbëve.',
      descriptionEn: 'Removal of tartar and polishing of the teeth.',
      sortOrder: 2,
    },
    {
      id: DEMO_IDS.services.filling,
      businessId,
      nameMk: 'Пломбирање на заб',
      nameSq: 'Mbushje dhëmbi',
      nameEn: 'Dental filling',
      durationMinutes: 60,
      price: 2500,
      currency: 'MKD',
      descriptionMk: 'Санација на кариес со бела композитна пломба.',
      descriptionSq: 'Trajtimi i kariesit me mbushje të bardhë kompozite.',
      descriptionEn: 'Caries treatment with a white composite filling.',
      sortOrder: 3,
    },
  ];

  for (const row of serviceRows) {
    await db
      .insert(services)
      .values(row)
      .onConflictDoUpdate({
        target: services.id,
        set: { ...row, active: true, updatedAt: new Date() },
      });
  }

  const staffRows: NewStaffMember[] = [
    {
      id: DEMO_IDS.staff.ana,
      businessId,
      name: 'д-р Ана Смилевска',
      serviceIds: [
        DEMO_IDS.services.checkup,
        DEMO_IDS.services.cleaning,
        DEMO_IDS.services.filling,
      ],
      // NULL = inherits the clinic's hours.
      workingHours: null,
    },
    {
      id: DEMO_IDS.staff.stefan,
      businessId,
      name: 'д-р Стефан Наумоски',
      serviceIds: [DEMO_IDS.services.checkup, DEMO_IDS.services.cleaning],
      workingHours: AFTERNOON_SHIFT,
    },
  ];

  for (const row of staffRows) {
    await db
      .insert(staff)
      .values(row)
      .onConflictDoUpdate({
        target: staff.id,
        set: { ...row, active: true, updatedAt: new Date() },
      });
  }

  return businessId;
}

async function main(): Promise<void> {
  loadRootEnv();
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set - copy .env.example to .env');

  const reset = process.argv.includes('--reset');
  const db = createDb({ url, authToken: process.env.DATABASE_AUTH_TOKEN });
  await enableForeignKeys(db);

  const businessId = await seedDemoBusiness(db, { reset });

  const [svc, stf] = await Promise.all([
    db.select().from(services).where(eq(services.businessId, businessId)),
    db.select().from(staff).where(eq(staff.businessId, businessId)),
  ]);

  console.log(`[seed] business   : ${businessId} (${DEMO_BUSINESS_SLUG})`);
  console.log(`[seed] services   : ${svc.length}`);
  for (const s of svc) console.log(`         - ${s.nameMk} (${s.durationMinutes} мин, ${s.price} ден)`);
  console.log(`[seed] staff      : ${stf.length}`);
  for (const s of stf) console.log(`         - ${s.name}`);
  if (reset) console.log('[seed] appointments and conversations were cleared (--reset)');

  db.$client.close();
}

// Run the CLI only when this file is the entry point, never when the API
// imports seedDemoBusiness for the Phase 7 demo-reset endpoint.
const entry = process.argv[1];
const isEntryPoint =
  entry !== undefined && import.meta.url === pathToFileURL(realpathSync(entry)).href;

if (isEntryPoint) {
  main().catch((error: unknown) => {
    console.error('[seed] failed:', error);
    process.exit(1);
  });
}
