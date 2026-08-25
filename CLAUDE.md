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
| Phone | **+1 619 349 7599** (Telnyx, US local). A +389 toll-free is requested and pending. |
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

Voice checks (all read-only, none of them place a call):

```bash
pnpm --filter @frontly/api verify:telnyx   # does the account match the code?
pnpm --filter @frontly/api bench:latency   # p50/p95 per stage of a turn
pnpm --filter @frontly/api verify:azure    # real TTS -> STT round trip
pnpm --filter @frontly/api simulate:call   # a whole call, no phone involved
pnpm --filter @frontly/core bench          # first-token vs first-sentence
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
- **A failed deploy leaves the OLD build running against the NEW schema.**
  `startCommand` is `pnpm db:migrate:dist && pnpm start`, so a start failure
  still migrates first. Render then keeps the previous instance serving — old
  code, new columns. That is how a live service ended up 500-ing on every
  `businesses` query (`no such column: twilio_number`) while `/health` stayed
  green, because health only pinged the database. When something looks wrong
  in production, check *which build* is running before debugging the code:
  `curl -X POST .../voice/incoming` answering means the pre-Telnyx build.
- **In production the voice channel is required, and asserted.** Missing
  `AZURE_SPEECH_KEY` or `TELNYX_API_KEY` now fails at boot with the variable
  named, and an `onReady` hook checks the routes are genuinely in the served
  route tree — `await app.register(...)` resolving proves a plugin ran, not
  that its routes reached the instance about to listen. `/health` reports the
  mounted webhook, so a green health check means the phone works.
- **`sync: false` in render.yaml means Render never sets it.** Renaming the
  `TWILIO_*` block to `TELNYX_*` added three declarations that must be filled
  in by hand in the dashboard; the rename alone carries nothing across.
- **A vendor name in a schema is a trap.** `businesses.twilio_number` became
  `inbound_number` (migration `0001`) when the carrier changed and will hold a
  +389 number next. Routing falls back to the only business when exactly one
  exists, which is why the demo works with the column still NULL.
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
- **The tool round trip is not the latency problem — a second model call is.**
  Measured over 24 turns: `check_availability` and `book_appointment` cost
  **8ms p50, 44ms p95**. A tool turn still costs ~2.4s more than a plain one,
  because the first model call emits no text at all (it only asks for the
  tool), so the spoken reply needs a whole extra generation. Optimising the
  database here would buy nothing; fewer round trips or a faster model is the
  only lever. `pnpm --filter @frontly/api bench:latency` re-measures it.
- **Fixed lines are pre-synthesized at boot** (`voice/speech-cache.ts`,
  warmed by `voice/warm.ts`). The greeting went from ~800ms to **~35ms** that
  way. The cache key includes the voice profile, not just the text — leaving
  `rate` or `voiceName` out would serve a re-voiced clinic its old audio, and
  the bug would only ever be audible. Warming happens in the background at
  boot; awaiting it would fail Render's health check.
- **A filler only helps if it is already synthesized.** If a turn is silent for
  800ms a cached acknowledgement plays ("Само момент", rotated so it is never
  the same twice running). When the cache is cold the session stays quiet on
  purpose — synthesizing a filler would cost exactly what the filler exists to
  hide.
- **The silence clock starts when the agent stops SPEAKING, not thinking.** It
  used to be armed the moment the model returned, while the reply was still
  playing, so any answer longer than the 6s window reprompted the caller over
  its own sentence — and the second reprompt hung up on them. Pre-synthesized
  phrases made it trivial to hit; the bug had been there all along.
- **`PlaybackQueue.whenDrained()` supports several waiters.** It used to hold a
  single callback, so the greeting, a turn and the silence timer waiting at
  once left all but the newest on a promise that never settled.
- **`tsc -p tsconfig.check.json` is the typecheck; the build config is not.**
  The build compiles only `src/` into `dist/`, which left `scripts/` and
  `*.test.ts` unchecked — two scripts with unterminated string literals passed
  a green `pnpm typecheck` and only failed when tsx ran them.
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

### Telnyx, and the Twilio assumptions that do not survive it

The carrier was Twilio until August 2026 and is now Telnyx (Twilio sells no
+389 inventory and gates its pricing API behind an upgrade Macedonia cannot
perform). Everything carrier-shaped lives behind `ITelephonyProvider` in
`apps/api/src/voice/telephony.ts`. Four differences bite, and every one of them
fails *silently* if carried across from Twilio:

- **Closing the media socket does not end the call.** Twilio's `<Connect>` was
  terminal. Telnyx keeps the socket and the call independent, so hang-up is an
  explicit `POST /calls/{id}/actions/hangup`. Skip it and the caller holds an
  open, silent, billable line.
- **There is no TwiML.** A call is answered by POSTing a command, and the media
  stream is opened by parameters on *that same command* — one round trip, not
  answer-then-`streaming_start`, which would leave the caller in silence while
  the second call is in flight.
- **The stream id is `stream_id` at the top level**, not `streamSid` inside
  `start`, and **outbound frames carry no identifier at all**.
- **`client_state` replaces `<Parameter>`.** It is base64, set on `answer`, and
  echoed back in the socket's `start` event. It is the only thing bridging the
  webhook and the media socket, which are separate connections — an in-memory
  map would not survive two Render instances.
- **Webhooks are signed with Ed25519 over `${timestamp}|${rawBody}`**, headers
  `telnyx-signature-ed25519` and `telnyx-timestamp`, 5-minute replay window.
  This needs the *raw bytes*: Fastify's default JSON parse plus a re-serialize
  is not byte-identical, so the voice plugin installs its own buffer parser.
- `stream_bidirectional_target_legs` is set to **`both`**, not the API default
  of `opposite`. An unbridged inbound leg has no opposite, and the docs do not
  say which side it counts as; `both` is correct under either reading. **If a
  live call connects but the caller hears nothing, this is the first knob.**
- **`transfer_to_human` needs an outbound voice profile** on the connection —
  a transfer places an outbound call. There is none yet, so the agent
  apologises and promises a callback instead of claiming a transfer it did not
  make. `pnpm --filter @frontly/api verify:telnyx` reports this.

## Demo data

`Дентал Охрид`, a dental clinic in Ohrid. Mon–Fri 09:00–17:00, Sat 09:00–13:00.
3 services, 2 staff. IDs are fixed (`biz_demo_…`, `svc_demo_…`) so seeding is
idempotent and the Phase 7 demo reset has a stable target. Dr Ana inherits the
clinic's hours; Dr Stefan works afternoons only, which keeps the slot maths
honest.

## Phases

1. Foundation — **done, deployed**
2. Conversation engine (`handleTurn`, tools, Macedonian prompt) — **done**
3. Voice channel (Telnyx ↔ Azure Speech) — **built, awaiting a real call**
4. Owner dashboard
5. Chat channel (embeddable widget)
6. Follow-up (SMS confirmation, reminder, daily summary)
7. Demo & metrics
8. Albanian pass, README, full deploy

Stop after each phase, show what works, wait for go-ahead.
