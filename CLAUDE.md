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
| Dashboard | https://frontly-web.vercel.app — Vercel, root directory `apps/web`, no build overrides. `frontly.vercel.app` belongs to somebody else. |
| Demo screen | `/demo` on that domain. Needs `APP_ORIGIN` on Render to include its origin, or CORS blocks every request and the screen stays empty. |

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
pnpm --filter @frontly/api tune:speech     # segmentation/barge-in, no redeploy
pnpm --filter @frontly/api verify:azure    # real TTS -> STT round trip
pnpm --filter @frontly/api simulate:call   # a whole call, no phone involved
pnpm --filter @frontly/core bench          # first-token vs first-sentence
```

## The working copy is `C:\dev\Frontly`. Never under OneDrive.

**OneDrive silently reverts files.** The repo used to live in
`C:\Users\...\OneDrive\Desktop\Frontly`, and OneDrive restored `.env` from an
older synced version twice — emptying live credentials mid-session. The tell is
an **mtime that moves backwards**: a write cannot stamp a file in the past, so a
timestamp older than a read you already did means sync replaced the file, not
that anyone edited it.

Beyond `.env`, a sync client racing a build over `node_modules/`, `dist/` and
`.next/` corrupts state in ways that look like compiler bugs. Keep the repo on
a plain local path.

### The second wipe (26 Aug 2026) was NOT OneDrive, and not git either

Investigated rather than assumed, because the obvious culprit had already been
removed. What was ruled out, with evidence:

- **OneDrive.** No sync process runs against this path, and `C:\dev` is a plain
  directory with no reparse point or junction. The repo really is local.
- **`git stash push --include-untracked` (`-u`).** Verified in a throwaway
  repo: it stashes untracked files and **leaves ignored files alone**, and
  `.env` is ignored. The file survived intact. This is safe to use.
- **`git add -A` / commit.** `.env` is ignored (`.gitignore:13`) and is not
  tracked, so it was never staged — and has never been committed.

Two commands **do** destroy it, both verified the same way, and both used to
sail past the guard:

- **`git clean` with `-x`** — `-x` means "including ignored files". File GONE.
- **`git stash push --all` (`-a`)** — `-a` stashes ignored files too. File GONE.

The root cause of this particular wipe could not be identified from the
evidence available; no audit trail exists. Do not invent one. What changed is
that every path Claude could take is now closed, and a wipe is now detectable
in seconds instead of at the next deploy.

**The signature to recognise:** the restored file had every variable present
and `DATABASE_URL` silently back to `file:./frontly.db` instead of the Turso
URL. Key-presence checks do not catch that. Fingerprints do — which is why
`pnpm env:check` prints a hash prefix per value rather than just a tick.

### What now guards it

- **`pnpm env:check`** — read-only. Reports byte count, variable count, and an
  8-char SHA-256 prefix per value (never the value). Run it after anything
  suspicious and compare fingerprints; a stale restore shows up as a changed
  hash on a variable nobody edited. It refuses to repair anything, by design.
- **`.claude/settings.json` matcher is `Bash|PowerShell`.** It used to be
  `Bash` alone, which meant every rule in the hook was unreachable from the
  PowerShell tool no matter how good the pattern was. A guard that cannot fire
  is not a guard — the same lesson as the jq version, and as the confidence
  score that was always 1.0.
- **The hook now also denies `git clean -x` and `git stash --all`**, and
  reads the command from several possible field names so a third shell tool
  cannot reopen the hole. `git stash -u` is deliberately still allowed:
  blocking it would be superstition, since it provably does not touch ignored
  files.
- **Read-only (`attrib +R`) is a PARTIAL defence, not a fix.** Measured:
  it blocks a `>` redirect (Permission denied) and a PowerShell overwrite
  (UnauthorizedAccessException); it does **not** stop either git command above,
  both of which deleted the file anyway. Worth setting, never worth trusting.
- The only thing that makes recovery instant is a copy of `.env` **outside the
  repo**, which duplicates live credentials and is therefore the owner's call,
  not ours to create.

## `.env` is the owner's file. Never write to it.

**Do not write, overwrite, regenerate, `cp .env.example .env`, `sed -i`, or
otherwise modify `.env` — ever, for any reason, even when asked to "fix" or
"restore" it.** It holds real credentials (Turso, Azure, Telnyx, Anthropic) that
only the owner has. Reading it is fine. `.env.example` is ours: put every new
variable there, with a comment, and tell the owner what to set.

If a key is missing or wrong, say which variable and what it needs — do not
repair it. If a script would need to write env values, it writes `.env.example`
or prints what to paste, and nothing else. **No file in this repo writes to any
file at all today; keep it that way.**

Enforced, not just documented: `.claude/settings.json` denies Write/Edit on
`.env`, and a `PreToolUse` hook (`.claude/hooks/protect-env.mjs`) refuses shell
commands that redirect, copy, `sed -i` or delete it. The hook is Node, not
bash+`jq` — **`jq` is not installed on this machine**, and the first version used
it, so every command parsed as empty and the guard allowed everything silently.

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
- **There are two "time to first audio" numbers and only one is the caller's.**
  The per-turn log line (`toFirstAudioMs`, ~805ms, suspiciously constant) is
  measured from `turnStartedAt` — *after* Azure has finalized. It is also just
  **the filler firing on schedule**: `DEFAULT_FILLER_AFTER_MS` is 800, so this
  number is a floor by construction and says nothing about model speed. The
  simulator's summary measures last caller frame → first reply frame, which is
  what the caller actually experiences: **~1480ms average**. They differ by the
  608-728ms Azure spends finalizing, and they sum. Neither is wrong; quoting the
  805ms as the caller's latency is.
  - A number that *improved* here was the warning sign: the phrase list made
    the summary look better (1142ms) purely by truncating utterances so Azure
    finalized early. Fixing recognition made the honest number worse.
  - **The segmentation timeout did NOT show up in this measurement** — 400ms and
    900ms produced the same end-to-end figure. That most likely means the
    simulator cannot see it, because injected TTS audio carries its own trailing
    silence and the timer expires before the last frame is written. Do not read
    it as evidence that segmentation is free on a real call, where the caller's
    pause is real time. It does mean **`simulate:call` cannot measure this
    tradeoff** — only a real call can.
- **A caller who switches language mid-call is not merely answered in the wrong
  language — they become untranscribable.** Measured 26 Aug 2026 with
  `verify:azure` (two utterances through ONE recognizer, which is what a call
  is; two separate `recognize()` calls each get their own detection and would
  both succeed, measuring nothing):

  | mode | utterance 1 | utterance 2 after the switch |
  |---|---|---|
  | `AtStart` (ships) | correct, 0.84–0.96 | **0.05**, pure garbage |
  | `Continuous` | correct, 0.84–0.96 | correct, 0.85–0.94 |

  Under `AtStart`, English after Macedonian came back as
  "Акто и крвта држи активни улиците." and Macedonian after English as
  "Sakamda Zakhazam's Tomatolovsky, Preglades Zoutre and outro." Both orders,
  every time. `SpeechServiceConnection_LanguageIdMode = AtStart` decides once
  from the opening audio and decodes the WHOLE connection that way.
  - **Opening in any language is fine** — detection is correct on the first
    utterance in every run. The failure needs a switch *after* the opening.
  - **0.05 is far below `minConfidence` (0.4), so the low-confidence path
    fires.** The agent says it did not catch you rather than acting on
    garbage: embarrassing, not dangerous. Nothing gets booked off a mistrans-
    lation.
  - **`Continuous` scored 4/4 and is deliberately NOT shipped — this is a
    known post-demo upgrade, already decided (owner, 26 Aug 2026). Do not
    re-derive it, and do not switch it on before 10 September.**
    The measurement cannot see the thing that makes it risky: these clips are
    clean TTS separated by 3s of digital silence, so nothing here tests a flip
    *mid-sentence* on a noisy 8kHz line. An agent that changes language partway
    through a sentence on stage is worse than one that is consistently in the
    wrong language. Simulated audio has already misled this project twice on
    timing; treat a clean 4/4 as "worth a real call", not "safe to ship".
    `languageIdMode` on `SpeechToTextOptions` exists only so the script can
    measure it — production never sets it, and the one-line change to adopt it
    is `azure.ts`'s `SpeechServiceConnection_LanguageIdMode`.
    **To revisit after the demo:** place a real call, greet in one language,
    switch mid-call, and compare against this table. That is the only evidence
    that would justify the change.
- **Time-to-first-token dominates voice latency**, not sentence length. Measured
  on Sonnet 5: 2.8s to first token, first sentence ~5ms later. Streaming cannot
  fix a slow first token — only a faster model, a shorter system prompt, or a
  cache hit can. `pnpm --filter @frontly/core bench` prints the split.
- **Azure ends a phrase after 500ms of silence by default, which is too
  eager for a phone call.** That is shorter than the pause a person takes
  working out which day suits them, so the agent answered half-finished
  sentences and talked over the rest. Fixed with
  `Speech_SegmentationSilenceTimeoutMs`, which is **only honoured under
  `Speech_SegmentationStrategy = "Time"`** — leaving the strategy at Default
  makes the timeout advisory. Azure's range is 100-5000ms. `"Semantic"` is
  also available (an AI model infers phrase boundaries, no parameters) and is
  worth trying if tuning by ear stalls, but is unverified for mk-MK.
- **The segmentation timeout is a direct addend to perceived latency.** The
  agent cannot begin answering until Azure has waited that long for the caller
  to continue. 900ms of silence tolerance is 900ms before the first token is
  even requested. Fewer interruptions and faster replies are the same dial;
  `pnpm --filter @frontly/api tune:speech --silence <ms>` writes it to the
  business row and the next call picks it up, with no restart or deploy.
- **The silence clock is a periodic check, not an armed timer.** Arming it
  was wrong twice, in two different ways, because there is no single correct
  moment to arm from. The playback queue empties *between* streamed sentences
  while the next is still being synthesized, so "nothing is playing" does not
  mean "the caller has gone quiet". `checkSilence` instead asks, on a tick,
  whether anyone has been audible — where audible means a turn running,
  a synthesis outstanding (`pendingSpeech`), or audio queued. Removing any one
  of those three makes the agent reprompt over its own next sentence.
- **Reprompts escalate and are capped.** Repeating the identical sentence is
  what turns "checking in" into "stuck in a loop", so `REPROMPTS` holds a
  short escalating list per language and the last one names the way out.
  After `maxReprompts` the agent offers a callback and hangs up cleanly rather
  than holding an open line.
- **An empty final recognition result is not a turn.** Azure occasionally
  finalizes on noise with no words in it; acting on one sends the model an
  empty message, resets the silence counter, and makes the agent speak
  unprompted — which sounds like it is talking to itself.
- **Every turn logs why it started** (`turn started` with a `reason`), because
  a reprompt and a real answer are indistinguishable in a transcript, and a
  call that felt like a loop cannot be read back without it.
- **Only a final recognition result starts a turn.** `recognizing` fires
  continuously with unstable hypotheses; acting on one answers a sentence the
  caller is halfway through. Partials are used for one thing only: confirming
  barge-in.
- **Barge-in needs confirmation, not energy.** `speechStartDetected` fires for
  a cough, a door, a car horn — and used to cut the agent off mid-sentence.
  It now only *arms* the interrupt, which fires on either a partial transcript
  with real words or sustained speech past `bargeInMs`. `speechEndDetected`
  before either cancels it.
- **A simulation that stops sending audio is not a phone call.** Telnyx
  delivers a 20ms frame every 20ms for the whole call, silence included, and
  Azure's end-of-phrase timer measures silence *in the audio it receives*.
  `simulate-call.ts` used to simply stop feeding between turns; once
  segmentation moved to the Time strategy that meant partials arrived and
  finals never did, and it looked exactly like a broken config. The simulator
  now runs a silence pump for the whole call and injects speech into it.
  Anything waiting on a turn must also wait longer than the segmentation
  timeout, or it declares the turn over before the agent has begun.
- **Never log success for a command the carrier rejected.** `command()`
  swallows "call already ended" because a caller hanging up races every
  command — but it used to return the same nothing as a 200, so a 422 whose
  body mentioned the call ending was reported as a clean answer and the route
  logged `call answered` for a call it never answered. Commands now return
  `'done' | 'call_gone'` and the log follows the outcome.
- **Webhook retries are routine on a cold instance**, where the first delivery
  times out while Render starts. `command_id` stops Telnyx acting twice; an
  in-process set of call refs stops us *logging* twice. It releases the ref
  when an attempt fails, or a retry after a real failure could never answer.
- **Never answer into a pipeline that cannot speak.** An inbound call waits
  (bounded) for the speech cache to finish warming. Past the bound it answers
  anyway and says so — on-demand synthesis is a real audio path, one Azure
  round trip slower, and it is what the session already falls back to.
- **The Azure phrase list is OFF, because it was measured and it is harmful.**
  It seemed obviously right — a receptionist for one clinic hears a tiny
  vocabulary, while a general model guesses among all of Macedonian over 8kHz.
  It made recognition worse. The 119-phrase list **truncated recognition at the
  first list entry it matched**: the greeting came back as "Добар ден." (an
  entry) at confidence **0.19 against 0.83** with no list, and likewise on three
  separate utterances. That is a decoder being constrained, not biased.
  - **The weight is inert.** 0.5, 1.0, 1.5 and 2.0 gave byte-identical output,
    so there is no value to tune to — and `setWeight(0)` cannot be trusted to
    mean "off" either. The list is skipped in code, not by passing weight 0.
  - **Nothing ever beat the baseline.** The best any configuration managed was
    **+0.00**: identical text, identical confidence.
  - What truncates is *volume × shortness*. The 102 entries of 1-2 words cost
    -0.58 to -0.63 on their own; the 17 of 3+ words were harmless; a 9-entry
    list of just staff and service names truncated nothing — but still scored
    +0.00 on "Сакам термин кај доктор Ана Смилевска…", the exact utterance a
    name list exists for. The safe configurations are worthless and the
    substantial ones are destructive.
  - **This caused the fragmenting, not segmentation.** "Добар ден, сакам да
    закажам стоматолошки преглед" arrived as two turns because the decoder
    stopped at a list entry. With the list off it is one turn, confidence 0.88.
  - **Confidence does not catch it.** The truncated booking sentence scored
    0.87 against a correct 0.88 — butchered text, healthy score — so every
    low-confidence defence is blind to this failure.
  `recognitionPhrases()` still exists and is still passed; only the weight gates
  it. `pnpm --filter @frontly/api sweep:phrases` re-measures the whole grid.
  Re-run it before assuming any of this holds for sq-AL, en-US or a new SDK.
  - **Verified end to end on 26 Aug 2026: the list never reaches a live call.**
    `azure.ts` attaches a `PhraseListGrammar` only when
    `recognition.phraseListWeight > 0`; the live weight comes from
    `recognitionFor(business.voiceConfig)`, and the seeded clinic's
    `voice_config` in Turso carries **no `recognition` key at all**, so every
    field falls to the schema default and the weight is 0. Checked against the
    production row, not inferred from the default.
  - **`verify:azure`'s old "+list" row was two baseline runs.** It called
    `recognize(audio, [language], phrases)` with no `recognition` config, so it
    fell back to `DEFAULT_RECOGNITION_CONFIG` — weight 0 — and the grammar was
    skipped on *both* sides. The `+0.00` it printed was a run agreeing with
    itself, and read as an A/B it said "the list is harmless", the exact
    opposite of the sweep's finding. The row is gone; `sweep:phrases` is the
    only script that sets the weight and so the only one that can A/B this.
  - **`tune:speech --phrase-weight` now refuses any value above 0.** It used to
    write a measured-harmful setting straight to the live business row, with no
    deploy and no test failure, and the next real call picked it up. 0 is still
    accepted so a stray weight can be zeroed without `--reset` flattening every
    other tuned value beside it. The refusal runs *before* the database is
    opened — verified by running it with an empty `DATABASE_URL`. Re-measuring
    has its own script, which sets the weight on scratch audio and writes to no
    business row: `sweep:phrases`.
- **The repeat-after-a-mishearing loop was NOT the reprompt timer.** Every
  low-confidence result spoke the same apology, uncapped: `lowConfidenceStreak
  >= 2` set an outcome field and changed no behaviour whatsoever. On a poor
  line every utterance lands there, so the caller heard one identical sentence
  forever, and no amount of `--reprompt-after` tuning touched it. There is now
  a `maxLowConfidenceTurns` cap that ends with a transfer or callback, and the
  apology escalates like the reprompts do.
- **Numeral dates are spelled out by the sanitiser, not just forbidden by the
  prompt.** The model writes "26 август" often enough, and Azure reads a bare
  numeral as a cardinal ("дваесет и шест"), which is wrong and audible. The
  pass runs *before* markdown stripping, because "1. јануари" at the start of
  a line is indistinguishable from a numbered list item. Note that JavaScript
  `` is defined over `[A-Za-z0-9_]` and does not fire around Cyrillic at
  all — the pattern uses lookarounds.
- **The apology loop is a race, and the cap alone does not break it.** The
  recognizer never hears our own audio — `stream_track: 'inbound_track'` is a
  hard split at the carrier, not an acoustic filter — so digital echo is ruled
  out. The loop is behavioural. `DID_NOT_CATCH` is a *cached* phrase, so it
  plays ~35ms after a result, faster than a person could have understood the
  sentence. A caller who pauses mid-thought is finalized on a fragment, which
  scores badly *because* it is a fragment; the instant apology lands while they
  are still talking; being talked over derails them into a disfluent restart;
  that finalizes as another fragment. Self-sustaining, driven by timing, which
  is why no `--reprompt-after` value ever touched it. The defences are
  `silentLowConfidenceTurns` (the first result is met with **silence** — a
  caller mid-sentence who hears nothing simply carries on) and
  `lowConfidenceHoldMs`, which is **a window to be interrupted in, not a
  delay**: any proof of life during it abandons the apology. A delay that still
  spoke afterwards would only move the collision later. Note the cap
  (`maxLowConfidenceTurns`) counts apologies **spoken**, not results seen — and
  on its own it did not fix anything, it converted an endless loop into a
  premature *hang-up*, since `handOver()` with no working transfer route speaks
  `TRANSFER_UNAVAILABLE` and ends the call. Two pauses from an audible caller
  would have dropped them.
- **The agent never hangs up on a caller who is audibly present.** It used to,
  and it was a stage-ending bug: *every* escape path ended in `onHangUp()`, so
  four low-confidence results in a row dropped the caller at roughly **ten
  seconds** — mid-sentence, on 2 of 4 real calls. The low-confidence cap called
  `handOver()`, which with no transfer route speaks `TRANSFER_UNAVAILABLE` and
  hung up. Adding the silence hold did **not** fix this: it changed how often
  apologies fire and left `cap → handOver → hangup` completely intact. Not
  recognising someone is not the same as them being gone — a bad line, an
  accent or a noisy room all produce sound we cannot transcribe, and every one
  of those is a person waiting.
  - `hangUp()` is now the **only** place that ends a call, and it refuses while
    `callerPresent` (any caller sound within `presenceWindowMs`, default 20s).
  - `lastCallerSoundAt` is bumped **only** by caller signals. `lastAudibleAt`
    counts the agent too, because it drives the quiet clock — using it for
    presence would let the agent's own voice prove the caller is there.
  - The only agent-initiated hangup left is `abandonAfterMs` (default **120s**)
    of *no caller sound at all*, so a dead line does not stay billable.
  - Every escape path now says its piece, calls `forgetTrouble()` to reset the
    counters, and keeps listening. Without that reset the next bad result walks
    straight back into the same dead end — the loop again, one level up.
- **Nothing used to tell the adapter a conversation was OVER, so the agent said
  goodbye and then asked if you were still there.** Heard on a real call: at
  ~45s it wished the caller a nice day, the line stayed open, and at ~1min the
  reprompt ladder started. The agent's farewell was ordinary text — there were
  five tools and none of them ended a call, and the prompt had no closing
  guidance at all — so the silence ladder treated a completed conversation
  exactly like an abandoned caller.
  - `end_call` is now a tool. It sets `state.concluded` and **does not hang up**:
    `packages/core` knows nothing about phones. The voice adapter waits
    `farewellGraceMs` (default 2500) *after playback drains* — measured from the
    end of the goodbye, or a long farewell eats its own courtesy window — then
    hangs up. Chat will simply stop.
  - **`hangUp()` bypasses the presence rule only when concluded.** The presence
    rule answers "has this caller gone away?", and for someone who just said
    "довидување" the answer is no, they are right there — which is exactly why
    they should not be held on an open line. A finished conversation is not an
    abandoned one. Everything that cannot tell those apart still goes through
    the presence rule, and `never hangs up on a caller who is audibly present`
    is still enforced by its own test.
  - **Concluding must STOP the silence watch, not merely decline to restart it.**
    `startSilenceWatch` installs a repeating interval, so the watch from the
    previous turn keeps ticking regardless. This was the actual reprompt.
  - **A concluded turn is exempt from the empty-reply fallback.** `end_call`
    normally arrives beside a goodbye, but a model that calls it alone has not
    malfunctioned — it has finished. The generic "the model said nothing at all"
    path put a *transfer apology* in the caller's ear at the moment of hanging
    up and recorded the call as `transferred`, the one outcome the stage metric
    counts as NOT resolved without the owner. A cached `FAREWELL` covers the
    silent case instead.
  - A caller who speaks during the grace cancels the close outright; the model
    can conclude again next turn.
- **The voice suite is timing-dependent, and adding tests to it perturbs the
  existing ones.** `stops talking as soon as the caller is confirmed to be
  speaking` failed **3 runs out of 3 on an unmodified tree** — it did
  `settle(10)` and then asserted audio was already flowing, which is a coin
  toss against Windows' ~15ms timer tick. It now polls (`waitFor`) instead.
  When a test here starts failing, check it against a stashed tree before
  believing the change caused it; and keep new tests short, with every session
  explicitly stopped, because real timers left running leak into what follows.
- **`call ended` logs `endedBy`.** `agent` / `caller` / `carrier` / `transfer`,
  plus `callerQuietForMs`. "Did we hang up on them or did they hang up on us?"
  previously required knowing which reason strings came from which layer, and
  it is the first question worth asking about any short call.
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

- **`.env` points at the SAME Turso database Render serves, so a local dev
  server is a production client.** It has to — that is how the seeded clinic is
  maintained — but it means `pnpm dev` plus the demo screen's reset button used
  to delete the live clinic's call history, its bookings and every number on
  the stage screen, from localhost, with nothing on screen naming the database.
  `POST /demo/reset` was also **unauthenticated on the public internet**, so
  anyone who guessed the path could blank the numbers mid-pitch.
  `resetRefusal()` in `routes/demo.ts` now decides, and it is two rules because
  they are two different accidents:
  - A process that is not production may only reset a `file:` database — its
    own. Presenting a token does not help; the rule is about which database.
  - Production requires `DEMO_RESET_TOKEN` (declared in the env schema and
    `render.yaml` since Phase 7 and, like `ANTHROPIC_MODEL` before it, read by
    nobody until now). A deploy without one **fails closed** with 503: an open
    wipe endpoint is the worse of the two failures to ship.
  The dashboard sends it as `Authorization: Bearer`, from
  `NEXT_PUBLIC_DEMO_RESET_TOKEN` — which lands in the browser bundle, so it is
  a lock on the door, not a secret. The rule that actually protects production
  is the first one, and it holds whatever the caller presents.
- **A raw-socket response drops every header a Fastify plugin staged.**
  `/demo/stream` writes SSE with `reply.raw.writeHead()` and never calls
  `reply.send()`, so the `Access-Control-Allow-Origin` that `@fastify/cors`
  set via `reply.header()` in its `onRequest` hook was never serialized. The
  failure is invisible from `app.inject()` and from same-origin dev, and lands
  precisely on stage: `/demo/metrics` answers with CORS headers so the numbers
  populate, while `EventSource` from the Vercel screen (or from localhost
  pointed at Render) is blocked by the browser and **the transcript stays
  blank forever**. `corsHeaders()` copies them across by name. Confirmed live
  before the fix: metrics returned the header, `/demo/stream` did not.
  Any future route that writes to `reply.raw` inherits this bug.
- **The demo screen's event bus is in-process, so it only sees calls that
  reached THAT instance.** A real call to +1 619 349 7599 is handled by Render.
  A demo screen pointed at `http://localhost:8080` (the default when
  `NEXT_PUBLIC_API_URL` is unset) subscribes to the laptop's empty bus, while
  `/demo/metrics` beside it queries Turso and shows real production numbers.
  Moving numbers next to a blank transcript is that misconfiguration, not a
  broken stream.

### Albanian: usable, NOT equal to Macedonian (measured 26 Aug 2026)

`pnpm --filter @frontly/api verify:albanian` re-measures all of this. Mean word
accuracy **83%**, language detection **3/3**, generated date/time phrasing
**100%**. Two findings matter more than those numbers:

- **The confidence score is INERT for sq-AL.** Every utterance came back at
  exactly **0.79** — spread across six real utterances: **0.00** — and
  Macedonian audio fed into an sq-AL recogniser, transcribed as obvious
  nonsense ("Do bardem sa kam dhe zakonshëm stomatolog shkipe get."), **also
  scored 0.79**. Macedonian by contrast ranges 0.19–0.88.
  - Consequence: `minConfidence`, `silentLowConfidenceTurns`,
    `maxLowConfidenceTurns` and the whole apology ladder **cannot fire in
    Albanian**. The agent will act on a mistranscription instead of admitting
    it did not catch it. This is the same class as "Azure returns 1.0 unless
    OutputFormat.Detailed is set" — a defence that cannot fire is not a
    defence — except here the constant is 0.79 and `Detailed` IS set.
  - Do NOT tune `--min-confidence` to fix this. There is no value that
    separates good Albanian from garbage, because they score identically.
- **Data capture is the weak point, and it is the core flow.** Proper nouns and
  digits degrade: "Dental Ohrid" → "dental Ohri", "Petrovski" → "petrovci",
  and a dictated phone number "shtatë zero një dy tre" came back
  "7. 0 1 2 3." — 57% word accuracy, the worst line in the run. Conversational
  Albanian scores 75–100%; it is names and numbers that fall over, which is
  exactly what a booking needs.

Fixed as a result of that run:

- **`sqTime` had no part-of-day marker.** A 14:30 slot was spoken
  "në orën 2 e gjysmë" with nothing to say whether that meant 2am or 2pm,
  while Macedonian has carried "попладне" all along. Now
  "në orën 2 e gjysmë pasdite", verified back through real TTS/STT at 100%.
- **`sanitizeForSpeech`'s `language` is now REQUIRED.** The Latin→Cyrillic pass
  only runs for `mk`, which is the only thing keeping it off Albanian — and the
  allowlist's single entry, `ime`, is an ordinary Albanian word ("my").
  Measured: with the language omitted (it defaulted to `mk`), an Albanian reply
  mentioning the clinic by its Cyrillic name had `ime` rewritten to `име` and
  would have been read aloud in Cyrillic by an Albanian voice. The engine
  always passed it, so this was latent — but Phase 5 adds a second adapter, and
  a required field cannot be forgotten.

**What the phrasing tables still lack:** a native speaker's ear. Every string
round-trips intact and the shapes are right; that is not the same as sounding
natural to someone from Tetovo. Worth 20 minutes with an Albanian speaker
before claiming it on stage.

### The chat widget (Phase 5), and what it proved about the boundary

Adding a whole channel meant **one adapter in `apps/api` and zero lines in
`packages/core`**. That was the test of the Phase 2 boundary and it held: the
prompt, the tools, the booking rules and the confirmation gate all came for
free through the same `handleTurn` the phone uses.

- **Verified channel-agnostic, not assumed.** A real booking was completed
  through the widget over HTTP against the live model, and `confirm_details`
  fired on chat with no chat-specific code — the agent read the number back
  digit by digit and waited before booking, exactly as it does on the phone.
- **Session state is in memory, deliberately, and symmetric with voice.**
  `CallSession` does the same. Both are ephemeral; the durable record is
  written to `conversations` on every turn, so a restart loses the same thing
  a dropped call does. Sessions are swept on touch rather than by a timer.
- **CORS is `*` on `/chat/*` and `/widget.js` and nowhere else.** The widget
  lives on the clinic's own website, whose origin this deployment cannot know.
  It is set in an `onSend` hook because the global `@fastify/cors` has already
  staged `APP_ORIGIN` by then and the later write wins. No credentials are
  involved, so `*` is honest rather than lazy.
- **Closed Shadow DOM.** A widget pasted onto someone else's page inherits
  their CSS otherwise, and a clinic stylesheet will happily restyle a `button`
  into something unusable. `/widget-demo` is a page with deliberately hostile
  styles (Comic Sans, magenta 28px buttons) that exists to prove the boundary
  holds — if the widget looks like the page around it, Shadow DOM is broken.
- **Two caps, because the endpoint is public and every message costs tokens:**
  1000 characters per message and 40 messages per session.
- **Switching language starts a NEW conversation.** The engine locks a
  conversation to one language, and half a transcript in Macedonian followed
  by half in Albanian is worse than starting over.
- **NOT verified in a real browser.** The script is valid JavaScript, serves
  with the right headers and is 10.7KB, but nothing has rendered it —
  Playwright is not installed and adding ~400MB of browsers before the
  deadline was not worth it. Open `/widget-demo` and look.

### `pnpm --filter @frontly/api dev` alone serves a STALE core

`apps/api` resolves `@frontly/core` to `packages/core/dist`, never to `src`.
`pnpm dev` at the root runs core's `tsc -b --watch` alongside, so the two stay
in step — but starting only the API filter does not, and the API then runs
whatever core was last built.

This is not theoretical: a booking went through the chat widget **without the
confirmation gate firing**, because the gate existed in `src` and the running
API was serving a `dist` from thirty minutes earlier. `pnpm test` and
`pnpm typecheck` both pass in that state, because they run against `src`.
Production is safe — Render runs `pnpm build` on every deploy — but a local
"it does not do the thing I just wrote" is this, every time. Rebuild core, or
use the root `pnpm dev`.

### The dashboard (Phase 4)

- **The dashboard is a CLIENT of the API, not a second copy of it.** That
  decision predates Phase 4 — it is written in `apps/web/next.config.ts` — and
  it is why `apps/web` has no drizzle in it and why `/dashboard/*` routes exist
  at all. Every read goes over HTTP so Vercel and Render cannot disagree about
  the data, and the database credentials stay on one machine. Do not "simplify"
  this by querying Turso from a server component.
- **Auth is a bearer token, not a cookie, and that is deliberate.** The two
  halves live on different origins, so a cookie set by the API would be
  cross-site and need `SameSite=None; Secure` plus credentialed CORS on every
  request. Instead: the browser holds an httpOnly cookie on the DASHBOARD's
  origin, and the dashboard's own server sends the token to the API in a
  header. The token never reaches client JavaScript, and there is no
  third-party cookie to be blocked.
- **The session check lives in the layout, not in middleware.** Middleware runs
  on the edge runtime where `node:crypto` does not exist, and the token is an
  HMAC. One redirect in a server component is cheaper than a second auth
  implementation.
- **Every dashboard query filters on the session's `businessId`, and that IS
  the tenancy boundary** — not defence in depth. A query that forgets it
  serves one clinic another clinic's patients. `dashboard.route.test.ts` proves
  it by asking for a real conversation id belonging to another business and
  requiring a 404.
- **`scrypt` from node:crypto, not bcrypt or argon2.** Both of those are native
  modules, and this repo has already lost a deploy to native postinstalls once
  (`allowBuilds` in pnpm-workspace.yaml). Login is not hot enough to justify
  re-opening that.
- **`pnpm db:create-owner --email <address>`** creates or re-passwords the
  login. The password is read from stdin — interactively when a TTY is
  present, piped otherwise — and never from a `--password` flag, which would
  put it in shell history, the process list, and any screenshot of the
  terminal taken during a demo.
- **The design shares the /demo screen's identity and none of its scale.** Same
  Cyrillic-native faces (Golos Text, IBM Plex Mono) and the same signal blue,
  because they are one product; but the demo is 17-22px for a projector ten
  metres away and the dashboard is 14px for a laptop at forty centimetres, and
  the demo's fixed full-viewport grid becomes an ordinary scrolling page.
  - **The day rail is the one bold element** and everything else is quiet on
    purpose. A clinic's day IS a column of time — the appointment book is the
    object this software replaces — so gaps between patients are drawn to
    scale via a `--gap-mins` custom property, clamped so a three-hour hole
    cannot push the day off screen. A grid of metric cards was the default
    answer and would have said nothing.
  - **Badges carry a label AND a shape, never colour alone** (circle, square,
    triangle, bar).
  - `ui-ux-pro-max` supplied the palette family and confirmed the density, but
    three of its recommendations were discarded and the reasons matter:
    its pattern was a marketing landing page (this is an authenticated tool),
    its style was "Exaggerated Minimalism" at `clamp(3rem, 10vw, 12rem)` (the
    opposite of "calm and legible"), and its font pairing was **Figtree, which
    has no Cyrillic coverage at all** — disqualifying for a Macedonian UI.
    Always check Cyrillic coverage before accepting a font recommendation.
- **Read-only on purpose in Phase 4:** the calendar (dragging an appointment
  means re-running availability, staff competence and the double-booking
  guard), and services/staff/working-hours. `inboundNumber` is not editable
  anywhere — it is the carrier's truth, and a typo silently unroutes every
  incoming call. The API refuses it too, so it is a locked door behind a
  locked door.
- **Next uses bundler resolution, so relative imports in `apps/web` must NOT
  carry `.js` extensions** — the opposite of every other package here, which is
  NodeNext and requires them.
- **Never run `next build` while a dev server is serving the same `.next`.**
  They corrupt each other's output and the symptom is a bogus
  `Cannot find module './472.js'` on an unrelated route. Clearing `.next` and
  restarting is the fix.

### SMS (Phase 6), and why the obvious registration is the wrong one

- **The number cannot text a single real customer.** Checked on the live
  account, not assumed: `+16193497599` is a `longcode` whose messaging
  features read `international_outbound: false`. Every customer is a +389
  mobile. So the US-domestic path is a *test harness*, not the product.
- **A2P 10DLC is the wrong lane.** It gates US long codes sending to US
  recipients. Registering it would have cost days and bought nothing for MK.
  The right route is an **alphanumeric sender ID** (`FRONTLY`), which is how
  the Balkans receive one-way notifications and needs Telnyx to enable it per
  destination country.
- **`TELNYX_SMS_FROM` is the entire switch.** `smsSender()` in
  `packages/shared` is the only code that knows the difference between sending
  from a number and sending from a name; alphanumeric additionally requires
  `TELNYX_MESSAGING_PROFILE_ID`, and setting one without the other fails at
  boot with the variable named.
- **Telnyx ACCEPTS an undeliverable message and fails later.** A 200 from the
  send call proves nothing, so `undeliverableReason()` refuses a US long code
  aimed at an international destination *before* spending the request. Without
  it the only evidence is a delivery receipt nobody is watching.
- **There is no queue, and that is the design.** "Has this been sent?" is a
  column on the appointment (`confirmation_sent_at`, `reminder_sent_at`), so
  every sweep is idempotent by construction and the hourly cron IS the retry.
  The one rule that must never break: **stamp after the carrier accepts, never
  before** — a stamp written first turns a transient failure into a message
  nobody ever receives, with no record that it was owed.
- **The cron is hourly and decides for itself what is due.** It is NOT
  scheduled at 20:00: Render's scheduler is UTC and `Europe/Skopje` is UTC+1 or
  +2 by season, so a summary pinned to a UTC hour arrives at 19:00 for half the
  year. `sendDailySummaries()` checks each business's own local clock instead.
  Day boundaries come off the calendar, not from adding 86,400,000ms, for the
  same reason.
- **The cron entry lives in `src/`, not `scripts/`.** The build compiles only
  `src/` into `dist/`, and Render must run compiled JavaScript — a cron under
  `scripts/` would need `tsx`, a dev dependency, in the production image.
- **A Macedonian SMS costs 70 characters, not 160.** Cyrillic is not in GSM-7,
  so the whole message becomes UCS-2 and a single part is 70 characters. This
  is not theoretical: the first reminder template came to **71** with the
  doctor's name in it and silently billed as two messages. The name lives in
  the confirmation instead, and `partsFor()` logs encoding and part count on
  every send so the next one shows up in a log line rather than an invoice.
- **Follow-up messages are NOT run through `sanitizeForSpeech`.** That pass
  spells numerals out because Azure reads "26" as "дваесет и шест". An SMS is
  read with the eyes, where "03.09 во 10:30" is both clearer and — given the
  70-character limit — cheaper.
- **Inbound SMS is logged and not answered.** Replying would mean a second
  conversation channel, and a channel is a `packages/core` adapter (Phase 5),
  not something to improvise inside a webhook.
- **Albanian is UCS-2 too, and that was missed for a whole phase.** `ë` and
  lowercase `ç` are not in GSM-7, so an Albanian SMS is 70 characters per part
  exactly like Cyrillic — but the Albanian confirmation was the *longest* of
  the three templates (118 chars) because it had been written as though it had
  160 to spend. Macedonian was 79. **English, the one language nobody here
  speaks, was the only one that fit.** The 70-character rule was documented for
  Cyrillic and then applied to Cyrillic only.
- **`confirmationText()` now COMPOSES to fit one part instead of being a fixed
  string.** It degrades in a defined order — full, then drop the staff name,
  then drop the weekday — and returns the first form that is one part. Tuning
  the wording to the length of "Дентал Охрид" would have worked for the demo
  clinic and broken for the first customer with a longer name; a 41-character
  clinic name now drops staff and weekday automatically and still fits.
  Measured saving: **$0.118 per booking**, which is more than the entire
  carrier cost of the call that produced it.

### What a conversation costs, measured (`measure:cost`)

`pnpm --filter @frontly/api measure:cost` counts tokens, TTS characters and SMS
parts from a real booking conversation, and reads the **carrier's actual
invoice** out of the Telnyx `usage_reports` API rather than applying a rate card
to an assumption. A booked 3-minute Macedonian call is **$0.389**; unbooked,
**$0.15**.

- **The follow-up SMS is 61% of a booked conversation** ($0.236 at the invoiced
  $0.118/part to a MK mobile). The phone call itself is the cheap part, and the
  carrier — the thing that feels expensive — is 5%.
- **Prompt caching halves the model cost**: $0.161 without, $0.075 with.
- **Telnyx pricing and usage are both readable from the API** with the ordinary
  key: `/v2/pricing?filter[service]=voice` for the rate card and
  `/v2/usage_reports?product=…&dimensions=date&metrics=cost,billed_sec` for what
  was actually charged. Note `dimensions`/`metrics` are **comma-separated**, not
  `[]`-bracketed, and dates must be full ISO-8601. Three products add up to one
  call and quoting only one is 3x low: `sip-trunking` (inbound minutes),
  `call-control` (commands), `media-streaming` (the audio socket, billed on its
  own shorter clock).
- **A +389 toll-free number would cost $0.535/min inbound from a mobile**, per
  Telnyx's own price sheet, against $0.07/min for a +389 *local* number. Every
  Macedonian customer is on a mobile. That is ~$1.60 for a three-minute call —
  four times the entire current cost of a booked conversation, carrier
  included. **The pending toll-free request is the expensive choice; local is
  the right one.** Worth deciding before the number is provisioned.
- Anthropic and Azure rates are published list prices, in one `RATES` block,
  overridable from the environment. Only the quantities are measured. Being
  pedantic about that split is the point: the quantities are where every
  surprise was.

### Capacity: three concurrent callers, and it is not a code problem

`pnpm --filter @frontly/api load:test` runs N whole calls at once;
`pnpm --filter @frontly/api probe:concurrency` finds the ceiling.

- **Azure refuses a fourth simultaneous transcription** —
  `websocket error code: 4429`, "the number of parallel requests exceeded the
  number of allowed concurrent transcriptions". Reproducible at exactly 3, with
  an 8-second settle between rounds to rule out the probe's own teardown. Every
  call holds one recognizer open for its whole duration, so **3 is a hard
  ceiling on simultaneous callers**. The 4th hears the greeting and is never
  heard back — it is not a timeout and no retry recovers it. Raising it is an
  **Azure tier change, not a code change**, and no latency work matters above
  this line.
- **Below the ceiling the process is fine.** Three concurrent calls: frame
  pacing p50 9ms late, p95 14ms, worst 55ms against a 20ms budget; heap ends
  lower than it started.
- **The double-booking guard was verified under real contention**, which is the
  measurement worth the runtime. Every caller asks for the same slot; exactly
  one gets it and the loser is told *"Извинете, тој термин штотуку го зазеде
  некој друг"* — the race is resolved in conversation, not just by an `INSERT`
  failing.
- **The load test measures pacing, not latency, and says so.** Injected TTS
  carries its own trailing silence, so caller-perceived latency from a
  simulator is still a floor rather than an experience. Frame pacing is the
  exception — that is real work on a real clock, so a late tick here is a late
  tick on a live call.
- **A load-test script can rot against a product change.** The first version
  used four caller turns and booked nothing, reporting every call as
  "abandoned", which looked exactly like a load failure. It was the Phase 6
  confirmation gate correctly refusing to book before the caller had heard
  their details read back. A fifth turn fixed it. `simulate:call` has the same
  four-turn script and the same problem.

### The stage metrics were wrong in the flattering direction

Found while measuring cost, on the screen the audience actually sees:

- **`resolvedWithoutOwnerPct` counted every ABANDONED caller as a success.** It
  was implemented as "any outcome except `transferred`", and abandoned is the
  most common outcome in the real history — so the headline read **82%** when
  the agent had completed 8 calls out of 39. A caller who gives up is the
  clearest failure there is; it simply is not a transfer.
  - **`SELF_RESOLVED_OUTCOMES` already existed in `packages/shared` with the
    correct list, and was imported by nobody.** Same shape as `ANTHROPIC_MODEL`
    and `DEMO_RESET_TOKEN`: declared, believed, never read. Grep for unused
    exports of this kind before trusting one.
  - The denominator now excludes only an `abandoned` call with **no turns at
    all** — someone who connected, heard the greeting and hung up in eleven
    seconds, which is a third of the real history. A *transfer* counts however
    empty its transcript is, because handing over IS the agent needing a human.
    A test caught the first version scoring a silent transfer as 100%.
- **`estimatedCostPerCallUsd` was 0.09, with a comment calling it
  "deliberately conservative".** It was 4x under. Measuring put a call at $0.15
  and a booked one at $0.39. Understating cost is the dangerous direction on a
  stage, because the follow-up question is what exposes it.
- **`avgCallerFacingMs` reads 11.0s and is a mean over 9 samples with one
  37-second outlier** — the median is 6.3s. Both numbers are real; the mean is
  the wrong statistic to put on a projector. Only 9 of 39 calls carry
  `callerFacingMs` at all, because the field was added after most of them.

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
5. Chat channel (embeddable widget) — **last, cut without hesitation**
6. Follow-up (SMS confirmation, reminder, daily summary)
7. Demo & metrics — **built, awaiting deploy**
8. Albanian pass, README, full deploy

Stop after each phase, show what works, wait for go-ahead.
