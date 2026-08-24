# Frontly

AI receptionist for small service businesses in North Macedonia and the wider
Balkans. Answers phone calls and web chat in Macedonian, Albanian and English,
books appointments, gives the owner a dashboard.

**Phone is the product.** Chat is a second adapter over the same engine. When
in doubt, prioritise the call pipeline.

Deadline: **10 September 2026** — incubator application + live stage demo.

## Live

| | |
|---|---|
| API | https://frontly.onrender.com — health: https://frontly.onrender.com/health |
| Database | Turso, `libsql://frontly-0kuculov.aws-eu-west-1.turso.io` (migrated + seeded) |
| Repo | https://github.com/0kuculov/frontly (`main` auto-deploys to Render) |
| Dashboard | not deployed yet (Phase 4 → Vercel) |

## Commands

```bash
pnpm dev            # api :8080 + dashboard :3000 + package watchers
pnpm build          # packages/* then apps/api  (what Render runs)
pnpm test           # every suite
pnpm typecheck
pnpm db:migrate     # apply migrations
pnpm db:seed        # upsert demo clinic (idempotent)
pnpm db:reset       # re-seed + clear its appointments/conversations
pnpm db:generate    # after ANY schema edit
pnpm db:studio
```

## Architecture invariant

The conversation engine is channel-agnostic. Dependencies point one way only:

```
apps/api ─┐
          ├─> packages/core ─> packages/shared
apps/web ─┘
```

- `packages/shared` — vocabulary with no I/O: Language, Channel, working hours,
  voice/SSML config, env schema.
- `packages/core` — database, booking rules, conversation engine. **Knows
  nothing about phones or browsers.**
- `apps/api` — Fastify. Channel adapters live here and nowhere else.
- `apps/web` — Next.js dashboard + embeddable widget.

Adding Viber/WhatsApp must mean writing one adapter in `apps/api`. If a change
requires touching the engine to add a channel, the change is wrong.

Nothing in `packages/` may import from `apps/`. When `apps/api` needed
migrations in a test, the fix was to export `runMigrations` from core — not to
add drizzle to the API.

## Non-obvious things that will bite

- **One `conversations` table for voice and chat**, told apart by `channel`.
  Never add a per-channel table.
- **Instants are UTC epoch millis.** Wall-clock strings (`"09:00"`) appear only
  inside working-hours JSON, interpreted against the business's timezone
  (`Europe/Skopje`).
- **Double-booking is prevented by a partial unique index**, not by app logic:
  `UNIQUE(staff_id, starts_at) WHERE status in ('booked','completed')`. Partial
  so a cancellation frees the slot. Booking code must handle the
  `UNIQUE constraint failed` rejection, not pre-check-then-insert.
- **`drizzle.config.ts` must not use `import.meta`.** drizzle-kit transpiles it
  to CJS, where `import.meta.dirname` is undefined and every command dies with
  `The "paths[0]" argument must be of type string`. It walks up for
  `pnpm-workspace.yaml` instead.
- **`DATABASE_URL=file:./frontly.db` is resolved against the repo root** by
  `packages/core/src/db/paths.ts`, so the API and the db scripts can't end up
  on two different files. A `file:` URL is rejected outright in production.
- **Per-phase secrets are optional at boot** and demanded at point of use via
  `requireEnv`. Do not add a hard boot requirement for a key a later phase
  needs — that blocked a Phase 1 deploy over a Phase 3 concern.
- **pnpm native postinstalls**: `allowBuilds: { esbuild: true, sharp: true }` in
  `pnpm-workspace.yaml`. pnpm writes that block itself with the placeholder
  `"set this to true or false"` — a placeholder is not approval and the install
  fails. The `"pnpm"` key in package.json is NOT read by pnpm 11.
- **`engines.node` is `>=24 <25`** and overrides Render's `NODE_VERSION`. An
  open `>=22` let a deploy pick up Node 26.
- **The engine may only offer times `check_availability` returned.** Enforced in
  `engine/executor.ts` against `state.offeredSlots`, not by the prompt. A single-day
  lookup returns EVERY free time; only multi-day ranges are sampled — handed a
  sample, the model tells callers an unlisted time is "unavailable", which is a
  confident lie about a free slot.
- **Every reply passes through `sanitizeForSpeech`.** Models reach for markdown
  bullets when listing options and TTS reads the asterisks aloud.
- **Live model tests are opt-in** (`FRONTLY_LIVE_TESTS=1`), not merely
  key-gated — a key is often exported in the shell and `pnpm test` must stay
  free and fast.
- **`ANTHROPIC_MODEL` must be read, not assumed.** It was declared in the env
  schema and consumed by nobody for all of Phase 2 — every call silently used a
  hardcoded constant. `resolveModelId()` is the only place that decides.
- **Time-to-first-token dominates voice latency**, not sentence length. Measured
  on Sonnet 5: 2.8s to first token, first sentence ~5ms later. Streaming cannot
  fix a slow first token — only a faster model, a shorter system prompt, or a
  cache hit can. `pnpm --filter @frontly/core bench` prints the split.
- **Azure STT returns no confidence unless `OutputFormat.Detailed` is set.**
  Without it every result scores 1.0 and the low-confidence path can never fire.
- **Azure's recognizer drops audio written before `startContinuousRecognitionAsync`
  resolves** — which is exactly the caller's opening words and the sample
  language detection runs on. `ISpeechToText.ready` exists for this.
- **An utterance arriving mid-turn must be queued, not dropped.** A caller who
  confirms while the agent is still thinking was silently ignored, and the
  booking never happened.
- Always synthesize speech via **SSML**, never plain text — plain text silently
  drops the prosody rate that makes the agent intelligible on an 8kHz line.
  Voice name and rate are **per-business config**, never constants.

## Demo data

`Дентал Охрид`, a dental clinic in Ohrid. Mon–Fri 09:00–17:00, Sat 09:00–13:00.
3 services, 2 staff. IDs are fixed (`biz_demo_…`, `svc_demo_…`) so seeding is
idempotent and the Phase 7 demo reset has a stable target. Dr Ana inherits the
clinic's hours; Dr Stefan works afternoons only, which keeps the slot maths
honest.

## Phases

1. Foundation — **done, deployed**
2. Conversation engine (`handleTurn`, tools, Macedonian prompt) — **done**
3. Voice channel — **built, unverified on a real call** (no Twilio number yet)
4. Owner dashboard
5. Chat channel (embeddable widget)
6. Follow-up (SMS confirmation, reminder, daily summary)
7. Demo & metrics
8. Albanian pass, README, full deploy

Stop after each phase, show what works, wait for go-ahead.
