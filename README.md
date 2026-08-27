# Frontly

AI receptionist for small service businesses in North Macedonia and the wider
Balkans. It answers phone calls and web chat in Macedonian, Albanian and
English, books appointments, and gives the owner a dashboard.

**Phone is the product.** Web chat is a second adapter over the same engine.

---

## Architecture

The conversation engine is channel-agnostic. Voice and chat are thin adapters
over one core, enforced by package boundaries rather than by convention:

```
packages/shared    vocabulary both sides share — Language, Channel, working
                   hours, voice/SSML config, env schema. No I/O.
packages/core      the database, booking rules, and (Phase 2) the engine.
                   Knows nothing about phones or browsers.
apps/api           Fastify HTTP + WebSocket server. Channel adapters live
                   here: Telnyx voice (Phase 3), chat socket (Phase 5).
apps/web           Next.js owner dashboard + embeddable chat widget.
```

The dependency arrow only ever points one way: `apps/*` → `packages/core` →
`packages/shared`. Nothing in `packages/` imports from `apps/`. Adding Viber or
WhatsApp later means writing one adapter in `apps/api`, not touching the engine.

Two schema decisions follow from that:

- **One `conversations` table for every channel**, told apart by `channel`.
  Every transcript view, metric and query is written once.
- **Instants are stored as UTC epoch millis.** Wall-clock strings (`"09:00"`)
  appear only inside working-hours JSON, interpreted against the business's
  own timezone.

---

## Stack

| Layer | Choice |
|---|---|
| Runtime | Node 24, TypeScript 5.9, ESM |
| API | Fastify 5 |
| Database | Turso (libSQL) + Drizzle ORM 0.45 |
| LLM | Anthropic Messages API, tool use for every booking action |
| Speech | Azure Speech (mk-MK, sq-AL, en-US) behind provider interfaces |
| Telephony | Telnyx Call Control v2 + Media Streaming over WebSockets |
| Dashboard | Next.js 15 App Router, Tailwind 4 |
| Hosting | Render (api, Frankfurt) + Vercel (web) |

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

Then:

```bash
curl http://localhost:8080/health
```

```json
{
  "status": "ok",
  "service": "frontly-api",
  "version": "0.1.0",
  "checks": { "database": { "status": "ok", "latencyMs": 1 } }
}
```

Phase 1 boots with **no** Telnyx, Azure or Anthropic keys. Those are validated
at the point the feature needs them, not at startup, so the foundation is
runnable before any account exists.

### Scripts

| Command | Does |
|---|---|
| `pnpm dev` | api + dashboard + package watchers |
| `pnpm build` | builds `packages/*` then `apps/api` |
| `pnpm test` | all suites (36 tests) |
| `pnpm db:migrate` | apply migrations |
| `pnpm db:seed` | upsert the demo clinic (idempotent) |
| `pnpm db:reset` | re-seed and clear its appointments + conversations |
| `pnpm db:generate` | generate a migration after editing the schema |
| `pnpm db:studio` | Drizzle Studio |

---

## Database

`DATABASE_URL` accepts either target, and the same generated SQL runs against
both — what is tested locally is what ships:

- `file:./frontly.db` for development (resolved against the repo root no matter
  which package the command runs from)
- `libsql://…turso.io` + `DATABASE_AUTH_TOKEN` in production

A `file:` URL is **rejected at boot in production**: Render's disk is
ephemeral, and every deploy would silently wipe the bookings.

### Double-booking guard

```sql
CREATE UNIQUE INDEX appointments_staff_slot_unique
  ON appointments (staff_id, starts_at)
  WHERE status in ('booked', 'completed');
```

Partial rather than a plain `UNIQUE(staff_id, starts_at)`, so a cancelled
appointment releases its slot instead of holding it hostage. It is enforced by
SQLite itself: two callers racing for the same 10:30 end with one `INSERT`
failing, not two bookings. Phase 2 builds its booking transaction on this.

### Demo data

One dental clinic in Ohrid — `Дентал Охрид`, Mon–Fri 09:00–17:00, Sat
09:00–13:00 — with 3 services and 2 staff. IDs are fixed (`biz_demo_…`) so
seeding is idempotent and the Phase 7 demo reset has a stable target. Dr Stefan
works afternoons only, which gives the Phase 2 slot maths something real to
chew on.

---

## Deployment

### API → Render

1. Create a Turso database and token:
   ```bash
   turso db create frontly
   turso db show --url frontly
   turso db tokens create frontly
   ```
2. Render → **New → Blueprint**, point it at this repo. [render.yaml](render.yaml)
   defines the service: Frankfurt, health check on `/health`, migrations run
   before the server binds.
3. Set the `sync: false` variables in the Render dashboard: `DATABASE_URL`,
   `DATABASE_AUTH_TOKEN`, `PUBLIC_BASE_URL`, `APP_ORIGIN`.
4. Seed once, from your machine, against the Turso URL:
   ```bash
   DATABASE_URL=libsql://… DATABASE_AUTH_TOKEN=… pnpm db:seed
   ```

Frankfurt is deliberate: Phase 3 has a 1.5s end-of-speech-to-response budget
shared between Telnyx, Azure and Anthropic, and a US region spends a third of
it on the round trip alone.

### Dashboard → Vercel

Import the repo, set **Root Directory** to `apps/web`, and add
`NEXT_PUBLIC_API_URL` pointing at the Render URL. Add that Vercel domain to
`APP_ORIGIN` on Render so CORS allows it.

---

## Phase status

| Phase | | |
|---|---|---|
| 1 | Foundation — monorepo, schema, seed, env, health | **done** |
| 2 | Conversation engine (`handleTurn`, tools, prompts) | **done** |
| 3 | Voice channel (Telnyx Media Streaming ↔ Azure Speech) | **built** |
| 4 | Owner dashboard | **done** |
| 5 | Chat channel (embeddable widget) | **done** |
| 6 | Follow-up (SMS confirmations, reminders, daily summary) | **done** |
| 7 | Demo & metrics | **done** |
| 8 | Albanian pass, README, full deploy | |
