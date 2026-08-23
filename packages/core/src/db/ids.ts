import { randomUUID } from 'node:crypto';

/**
 * Prefixed, URL-safe IDs. The prefix costs four bytes and pays for itself the
 * first time a Twilio log line or a stage-demo transcript shows `apt_…` and
 * you know instantly what you are looking at.
 */
export const ID_PREFIXES = {
  business: 'biz',
  service: 'svc',
  staff: 'stf',
  appointment: 'apt',
  conversation: 'conv',
} as const;

export type IdKind = keyof typeof ID_PREFIXES;

export function newId(kind: IdKind): string {
  return `${ID_PREFIXES[kind]}_${randomUUID().replaceAll('-', '')}`;
}
