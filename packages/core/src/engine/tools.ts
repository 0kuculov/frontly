import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';

/**
 * The five things the agent can do.
 *
 * Every booking action is a tool call. The model is never trusted to describe
 * a booking in prose and have something else parse it — if it did not call a
 * tool, nothing happened.
 *
 * Each schema has a zod twin below. The JSON Schema tells Claude what to send;
 * the zod schema is what the executor actually trusts, because a tool input is
 * model-generated text and gets validated like any other untrusted input.
 * Schemas are written strict-compatible (every property required,
 * `additionalProperties: false`, optionals expressed as nullable) so that
 * `strict: true` can be switched on once it has been verified against the live
 * API — see buildTools().
 */

const dateDescription = 'Календарски датум во формат YYYY-MM-DD, во времето на бизнисот.';
const instantDescription =
  'Точен почеток како ISO 8601 instant со временска зона, точно онака како што го врати check_availability (пример: 2026-09-03T08:30:00.000Z).';

export const checkAvailabilityInput = z.object({
  service_id: z.string().min(1),
  date_from: z.string(),
  date_to: z.string(),
  staff_id: z.string().nullable().optional(),
});

export const bookAppointmentInput = z.object({
  service_id: z.string().min(1),
  staff_id: z.string().min(1),
  starts_at: z.string().min(1),
  customer_name: z.string().min(1),
  customer_contact: z.string().min(1),
});

export const cancelAppointmentInput = z.object({
  customer_contact: z.string().min(1),
  appointment_id: z.string().nullable().optional(),
});

export const rescheduleAppointmentInput = z.object({
  appointment_id: z.string().min(1),
  new_starts_at: z.string().min(1),
});

export const transferToHumanInput = z.object({
  reason: z.string().min(1),
});

export const TOOL_NAMES = [
  'check_availability',
  'book_appointment',
  'cancel_appointment',
  'reschedule_appointment',
  'transfer_to_human',
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

export interface BuildToolsOptions {
  /**
   * Server-side schema enforcement. Off by default: it has not been verified
   * against the live API from this repo, and a 400 discovered mid-call is
   * worse than the zod validation the executor already performs. Turn on once
   * a real request has been made successfully.
   */
  strict?: boolean;
}

export function buildTools(options: BuildToolsOptions = {}): Anthropic.Tool[] {
  const strict = options.strict ?? false;
  const withStrict = (tool: Anthropic.Tool): Anthropic.Tool =>
    strict ? { ...tool, strict: true } : tool;

  return [
    withStrict({
      name: 'check_availability',
      description:
        'Врати слободни термини за одредена услуга во даден период. ЕДИНСТВЕН извор на вистина ' +
        'за слободни термини — никогаш не смееш сам да измислуваш или да претпоставуваш време. ' +
        'Повикај ја оваа алатка пред да понудиш било кој термин.',
      input_schema: {
        type: 'object',
        properties: {
          service_id: { type: 'string', description: 'ID на услугата од списокот подолу.' },
          date_from: { type: 'string', description: `Почеток на периодот. ${dateDescription}` },
          date_to: { type: 'string', description: `Крај на периодот. ${dateDescription}` },
          staff_id: {
            type: ['string', 'null'],
            description: 'ID на конкретен вработен, или null за сите.',
          },
        },
        required: ['service_id', 'date_from', 'date_to', 'staff_id'],
        additionalProperties: false,
      },
    }),

    withStrict({
      name: 'book_appointment',
      description:
        'Закажи термин. Повикај ја САМО откако пациентот експлицитно потврдил услуга, датум, ' +
        'време и име. starts_at мора да биде точно еден од термините што ги врати ' +
        'check_availability — секој друг ќе биде одбиен.',
      input_schema: {
        type: 'object',
        properties: {
          service_id: { type: 'string' },
          staff_id: { type: 'string' },
          starts_at: { type: 'string', description: instantDescription },
          customer_name: { type: 'string', description: 'Целото име на пациентот.' },
          customer_contact: { type: 'string', description: 'Телефонски број за контакт.' },
        },
        required: ['service_id', 'staff_id', 'starts_at', 'customer_name', 'customer_contact'],
        additionalProperties: false,
      },
    }),

    withStrict({
      name: 'cancel_appointment',
      description: 'Откажи постоечки термин по телефонски број на пациентот.',
      input_schema: {
        type: 'object',
        properties: {
          customer_contact: { type: 'string', description: 'Телефонскиот број на пациентот.' },
          appointment_id: {
            type: ['string', 'null'],
            description: 'ID на терминот ако е познато, инаку null.',
          },
        },
        required: ['customer_contact', 'appointment_id'],
        additionalProperties: false,
      },
    }),

    withStrict({
      name: 'reschedule_appointment',
      description:
        'Премести постоечки термин на ново време. new_starts_at мора да доаѓа од ' +
        'check_availability.',
      input_schema: {
        type: 'object',
        properties: {
          appointment_id: { type: 'string' },
          new_starts_at: { type: 'string', description: instantDescription },
        },
        required: ['appointment_id', 'new_starts_at'],
        additionalProperties: false,
      },
    }),

    withStrict({
      name: 'transfer_to_human',
      description:
        'Пренеси го разговорот на човек. Користи ја кога прашањето е надвор од закажување — ' +
        'цени што ги нема во списокот, медицински совет, поплаки — или кога не си сигурен. ' +
        'Подобро е да пренесеш отколку да погодуваш.',
      input_schema: {
        type: 'object',
        properties: {
          reason: {
            type: 'string',
            description: 'Кратка причина на македонски, за сопственикот на ординацијата.',
          },
        },
        required: ['reason'],
        additionalProperties: false,
      },
    }),
  ];
}
