# Frontly

An AI receptionist for small service businesses in North Macedonia and the
wider Balkans. It answers the phone and the web chat in Macedonian, Albanian
and English, books appointments against real availability, sends the
confirmation and the reminder, and gives the owner a dashboard.

**Phone is the product.** Web chat is a second adapter over the same engine —
adding it took one file in `apps/api` and zero lines in the engine.

---

## Architecture

The conversation engine is channel-agnostic, and that is enforced by package
boundaries rather than by good intentions:

```
                    ┌───────────────────────────────┐
   ☎  Telnyx ──────►│  apps/api                     │
   (voice + SMS)    │                               │
                    │   voice/   ← Telnyx ↔ Azure   │
   💬 widget.js ───►│   chat/    ← HTTP             │─┐
                    │   sms/     ← follow-ups       │ │
                    │   routes/  ← dashboard, demo  │ │
                    └───────────────────────────────┘ │
                                                      │
   🖥  apps/web  ────────────────────────────────────►─┤
      Next.js dashboard (an HTTP client of the API)   │
                                                      ▼
                              ┌────────────────────────────────┐
                              │  packages/core                 │
                              │   engine/   handleTurn, tools  │
                              │   booking/  rules, follow-ups  │
                              │   db/       schema, queries    │
                              │   time/     zones, speech      │
                              │                                │
                              │  KNOWS NOTHING ABOUT PHONES    │
                              │  OR BROWSERS                   │
                              └────────────────────────────────┘
                                             │
                              ┌────────────────────────────────┐
                              │  packages/shared               │
                              │  Language, Channel, hours,     │
                              │  voice/SSML config, env schema │
                              │  No I/O.                       │
                              └────────────────────────────────┘
```

The dependency arrow points one way only: `apps/*` → `packages/core` →
`packages/shared`. Nothing in `packages/` may import from `apps/`. When a test
in `apps/api` needed migrations, the fix was to export `runMigrations` from
core — not to add drizzle to the API.

**Adding Viber or WhatsApp means writing one adapter in `apps/api`.** If a
change needs the engine edited to add a channel, the change is wrong. This was
tested for real in Phase 5: the chat widget got the prompt, the tools, the
booking rules and the confirmation gate for free, and `confirm_details` fired
on chat with no chat-specific code.

Two schema decisions follow from the same idea:

- **One `conversations` table for every channel**, told apart by a `channel`
  column. Every transcript view, metric and query is written once.
- **Instants are UTC epoch millis.** Wall-clock strings (`"09:00"`) appear only
  inside working-hours JSON, interpreted against the business's own timezone.

---

## Stack

| Layer | Choice |
|---|---|
| Runtime | Node 24, TypeScript 5.9, ESM |
| API | Fastify 5 |
| Database | Turso (libSQL) + Drizzle ORM |
| LLM | Anthropic Messages API, tool use for every booking action |
| Speech | Azure Speech (mk-MK, sq-AL, en-US) behind provider interfaces |
| Telephony | Telnyx Call Control v2 + Media Streaming over WebSockets |
| Dashboard | Next.js 15 App Router, Tailwind 4 |
| Hosting | Render (API, Frankfurt) + Vercel (dashboard) |

Frankfurt is deliberate: a turn has a tight end-of-speech-to-audio budget
shared between Telnyx, Azure and Anthropic, and a US region spends a third of
it on the round trip alone.

---

## What one conversation actually costs

Every quantity below is **counted**, not estimated:

```bash
pnpm --filter @frontly/api measure:cost
```

It runs a real booking conversation against the real model, counts the tokens
the API reports, counts the characters that reach the synthesizer, counts the
SMS parts the templates produce — and reads the **carrier's actual invoice**
out of the Telnyx usage API rather than applying a rate card to a guess.

A booked, three-minute Macedonian call:

| | | |
|---|---:|---|
| Follow-up SMS (2 parts) | **$0.236** | invoiced at $0.118/part to a MK mobile |
| Model (Sonnet, prompt cached) | **$0.075** | 8 calls, ~13k in / ~800 out |
| Azure STT | **$0.050** | billed on call duration, silence included |
| Telnyx | **$0.018** | trunking + call control + media streaming |
| Azure TTS | **$0.009** | ~600 characters; fixed lines are cached |
| **Total** | **$0.389** | |

An unbooked call is **$0.15** — the SMS is 61% of the bill and only a booking
sends one.

Three things that measuring changed, all of which reading the code would not
have told you:

- **A Macedonian SMS costs more than the phone call that produced it.**
  Cyrillic is not in GSM-7, so a message is UCS-2 at **70 characters per
  part**. The confirmation was 79 characters and silently billed as two. So
  did the Albanian one, at 118 — `ë` and lowercase `ç` are not in GSM-7
  either, and the Albanian template was the longest of the three because it
  had been written as though it had 160 characters to spend. English, the one
  language nobody here speaks, was the only one that fit. Fixing that cut the
  cost of a booked conversation by **27%**.
- **Prompt caching is not a rounding error.** The same conversation costs
  $0.161 without it and $0.075 with it.
- **The carrier is the cheapest thing in the product.** Optimising it would
  buy nothing; the SMS and the model are the whole bill.

The rates for Anthropic and Azure are published list prices, kept in one block
at the top of the script and overridable from the environment, so they can be
re-checked in thirty seconds without reading any code. The Telnyx figures are
not rates at all — they are what the account was charged.

---

## Capacity, honestly

```bash
pnpm --filter @frontly/api load:test          # 5 concurrent calls
pnpm --filter @frontly/api probe:concurrency  # where the ceiling is
```

**Azure Speech refuses a fourth simultaneous transcription** on this resource
(`websocket error code: 4429`). Measured, reproducibly, at exactly 3. Every
call holds one recognizer open for its whole duration, so this is a hard
ceiling on how many people can be talking to Frontly at once — not a tuning
parameter, and not something a retry recovers from. The fourth caller hears
the greeting and is never heard back. **Raising it is an Azure tier change,
not a code change.**

Below that ceiling, three concurrent calls on one process behave:

- **frame pacing** p50 9ms late, p95 14ms, worst 55ms, against a 20ms budget —
  the audio keeps flowing
- **no leaks** — heap ends lower than it started
- **the double-booking guard holds.** Every caller in the load test asks for
  the same slot on purpose. Exactly one gets it, and the loser is told
  *"Извинете, тој термин штотуку го зазеде некој друг"* — the race is resolved
  in conversation, not just in the database.

What the load test deliberately does **not** claim is latency. Simulated audio
has misled this project twice, because injected speech carries its own trailing
silence; only a real call measures what a caller feels. Frame pacing is the
exception, and it is called out as such — that is real work on a real clock.

---

## Local setup

```bash
pnpm install
cp .env.example .env      # defaults to a local file: database, no keys needed
pnpm build
pnpm db:migrate
pnpm db:seed
pnpm dev                  # api on :8080, dashboard on :3000
```

```bash
curl http://localhost:8080/health
```

```json
{
  "status": "ok",
  "service": "frontly-api",
  "checks": {
    "database": { "status": "ok", "latencyMs": 1 },
    "voice": { "status": "ok", "carrier": "telnyx", "webhook": "/telnyx/voice" }
  }
}
```

The API boots with **no** Telnyx, Azure or Anthropic keys — they are demanded at
the point of use, so the foundation runs before any account exists. Production
is stricter: the voice channel is asserted at boot, and a missing
`AZURE_SPEECH_KEY` or `TELNYX_API_KEY` fails with the variable named.

> **Run `pnpm dev` at the repo root, not `pnpm --filter @frontly/api dev`.**
> `apps/api` resolves `@frontly/core` to `packages/core/dist`, never `src`, so
> the API filter alone serves whatever core was last built. A booking once went
> through the chat widget without the confirmation gate firing for exactly that
> reason, while `pnpm test` and `pnpm typecheck` stayed green — they run
> against `src`.

### Commands

| Command | Does |
|---|---|
| `pnpm dev` | api + dashboard + package watchers |
| `pnpm build` | `packages/*` then `apps/api` (what Render runs) |
| `pnpm test` | every suite — 273 passing, plus 6 live-model tests behind `FRONTLY_LIVE_TESTS=1` |
| `pnpm typecheck` | `tsc -p tsconfig.check.json` — covers `scripts/` and tests |
| `pnpm env:check` | read-only `.env` fingerprints; never prints a value |
| `pnpm db:migrate` / `db:seed` / `db:reset` / `db:generate` / `db:studio` | database |
| `pnpm db:create-owner --email <address>` | create or re-password a dashboard login |

Every check below is read-only and none of them places a call:

| Command | Answers |
|---|---|
| `measure:cost` | what one conversation costs, counted |
| `load:test` | 5 concurrent calls: contention, pacing, leaks |
| `probe:concurrency` | how many callers Azure will hear at once |
| `bench:latency` | p50/p95 per stage of a turn |
| `simulate:call` | a whole call, no phone involved |
| `verify:telnyx` | does the carrier account match the code? |
| `verify:azure` | real TTS → STT round trip |
| `verify:albanian` | sq-AL recognition, phrasing, and what it costs |
| `sweep:phrases` | re-measure the phrase-list grid |
| `tune:speech` | segmentation/barge-in, live, no redeploy |
| `follow-up -- --dry-run` | what the SMS sweeps would send, sending nothing |
| `@frontly/core bench` | first-token vs first-sentence |

---

## Database

`DATABASE_URL` takes either target and the same generated SQL runs against
both, so what is tested locally is what ships:

- `file:./frontly.db` for development, resolved against the repo root no matter
  which package the command runs from
- `libsql://…turso.io` + `DATABASE_AUTH_TOKEN` in production

A `file:` URL is **rejected at boot in production**: Render's disk is
ephemeral, and every deploy would silently wipe the bookings.

### Double-booking guard

```sql
CREATE UNIQUE INDEX appointments_staff_slot_unique
  ON appointments (staff_id, starts_at)
  WHERE status in ('booked', 'completed');
```

Partial rather than plain, so a cancellation releases its slot instead of
holding it hostage. It is enforced by SQLite itself: two callers racing for
10:30 end with one `INSERT` failing, not two bookings. Booking code handles the
rejection — it does not pre-check and then insert.

### Demo data

`Дентал Охрид`, a dental clinic in Ohrid. Mon–Fri 09:00–17:00, Sat 09:00–13:00,
3 services, 2 staff. IDs are fixed (`biz_demo_…`) so seeding is idempotent and
the demo reset has a stable target. Dr Ana inherits the clinic's hours; Dr
Stefan works afternoons only, which keeps the slot maths honest.

---

## Deployment

### API → Render

1. Create a Turso database and token:
   ```bash
   turso db create frontly
   turso db show --url frontly
   turso db tokens create frontly
   ```
2. Render → **New → Blueprint**, pointed at this repo. [render.yaml](render.yaml)
   defines the service: Frankfurt, health check on `/health`, migrations run
   before the server binds.
3. Set every `sync: false` variable by hand in the Render dashboard.

> `sync: false` means Render never sets it, and `generateValue: true` only
> fires when the blueprint is **first** applied. A service that predates an
> entry will not have it — which is exactly how the whole dashboard API sat
> dark behind a 404 with `AUTH_SECRET` unset, while `/health` stayed green.
> After any deploy, check a route that needs the variable, not just health.

### Dashboard → Vercel

Import the repo, set **Root Directory** to `apps/web`, add `NEXT_PUBLIC_API_URL`
pointing at the Render URL, and add the Vercel domain to `APP_ORIGIN` on Render
so CORS allows it.

The dashboard is a **client of the API, not a second copy of it** — every read
goes over HTTP, so Vercel and Render cannot disagree about the data and the
database credentials stay on one machine. Auth is a bearer token rather than a
cookie because the two halves live on different origins: the browser holds an
httpOnly cookie on the dashboard's origin, and the dashboard's own server sends
the token to the API in a header.

---

## Known limits

Things that are measured and true, rather than hoped for:

- **Three concurrent callers.** An Azure resource limit, above.
- **Albanian confidence scoring is inert.** Every sq-AL utterance comes back at
  exactly 0.79 — including Macedonian audio transcribed as nonsense. The
  low-confidence defences that protect Macedonian **cannot fire in Albanian**,
  and no threshold separates good from garbage because they score identically.
  Word accuracy is 83%; names and dictated digits are the weak point, and those
  are what a booking needs.
- **A caller who switches language mid-call becomes untranscribable.** Azure
  decides the language once from the opening audio and decodes the whole
  connection that way. Opening in any language is fine. `Continuous` detection
  scores 4/4 in a clean test and is deliberately not shipped before a live call
  confirms it does not flip mid-sentence on an 8kHz line.
- **The Azure phrase list is off, because it was measured and it is harmful.**
  It truncated recognition at the first list entry it matched — confidence 0.19
  against 0.83 — and no configuration ever beat the baseline.
- **The chat widget has not been opened in a real browser.** It is valid
  JavaScript, serves with the right headers, and `/widget-demo` exists to look
  at it on a deliberately hostile page. Nothing has rendered it.
- **Transfer to a human is not wired up.** It needs an outbound voice profile
  on the Telnyx connection, and there is none, so the agent apologises and
  promises a callback rather than claiming a transfer it did not make.

---

## Phase status

| Phase | | |
|---|---|---|
| 1 | Foundation — monorepo, schema, seed, env, health | **done** |
| 2 | Conversation engine (`handleTurn`, tools, prompts) | **done** |
| 3 | Voice channel (Telnyx Media Streaming ↔ Azure Speech) | **done** |
| 4 | Owner dashboard | **done** |
| 5 | Chat channel (embeddable widget) | **done** |
| 6 | Follow-up (SMS confirmations, reminders, daily summary) | **done** |
| 7 | Demo & metrics | **done** |
| 8 | Albanian pass, README, full deploy | **done** |
