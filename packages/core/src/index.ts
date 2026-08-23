/**
 * @frontly/core — the channel-agnostic half of Frontly.
 *
 * Everything a conversation needs lives here: the database, the booking
 * rules, and (from Phase 2) the engine itself. Nothing in this package knows
 * whether it is talking to a phone or a browser. Adapters live in apps/api.
 */
export * from './db/index.js';
