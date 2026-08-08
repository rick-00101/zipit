# Zepit — status

Last updated: **2026-08-07**. Hackathon window: **Aug 8–9, 2026** (48 hrs, solo).

## Progress against plan.txt §13

| # | Step | Status |
| --- | --- | --- |
| 1 | Zerops account + Personal Access Token | **Done** — account `rick-00101` (thakur34980@gmail.com), PAT issued |
| 2 | Install zcli, log in, sanity check | **Done** — zcli v1.1.0, authenticated |
| 3 | Hand-write one import YAML and provision it manually | **Done** — `realtime-chat` live and behavior-verified |
| 4 | Zepit backend + job table, hard-coded archetype, full pipeline | **Done — verified live on Zerops 2026-08-07** |
| 5 | Add the single structured LLM call | **Done — verified against the real Gemini API 2026-08-08** |
| 6 | Frontend; deploy Zepit itself on Zerops | **Done — LIVE 2026-08-07**, pending two secrets |
| 7 | Rehearse demo, build post, video, AI disclosure | Not started |

## What exists in the repo

```
plan.txt                              original handoff doc (now annotated with corrections)
PIPELINE.md                           the validated provisioning sequence + the gotchas   ← read first
STATUS.md                             this file
scripts/verify-realtime-chat.js       behavior health check (WS upgrade → broadcast → persistence)
templates/realtime-chat/
  manifest.json                       catalog entry: id, description, services, fillable fields
  import.template.yaml                infra skeleton with {{placeholders}}
  api/         server.js, package.json, package-lock.json, zerops.yaml
  frontend/    index.html, config.js (generated per deploy), zerops.yaml
```

## Archetype 1: `realtime-chat` — validated

Three services, provisioned by hand into the sandbox, deployed from local folders via
`zcli service push`, and confirmed working through the public internet:

| service | type | access |
| --- | --- | --- |
| chatdb | postgresql:single@16 | private |
| chatapi | nodejs@22 | https://chatapi-2a30-3000.prg1.zerops.app |
| chatweb | static | https://chatweb-2a30.prg1.zerops.app |

Verified: `/healthz` reports `db: up` and echoes the personalization values (proving
`envSecrets` and cross-service `${chatdb_*}` refs resolve); WebSocket upgrade succeeds
over `wss` through the subdomain; a message sent by one client reaches a second client
and persists to Postgres. Two browser tabs chat with each other, history survives reload.

**The golden rule holds:** the URL was only trusted after the behavior check passed.

## What the trial changed about the design

- Personalization goes through **`envSecrets`**, not `envVariables` (which is silently
  ignored at import level).
- Subdomains are enabled by an **explicit `zcli` call after the first push**, never by an
  import-YAML flag — and the API must be pushed before the frontend, because the
  frontend needs the API's resolved URL.
- The frontend gets its API URL from a **generated `config.js`** written into the job's
  copy of the template. No build-time substitution, no source edits — the same tested
  source ships every time, which is exactly the property we promised judges.
- Templates commit their **`package-lock.json`** or `npm ci` fails the build.
- Reading a service's public URL needs the **REST API**, not zcli.

Full detail with symptoms and error codes: `PIPELINE.md`.

## FIRST FULLY AUTOMATED DEPLOY — 2026-08-07

Zepit provisioned, deployed and verified a working app end to end with no human in the
loop. One `POST /api/deploy` produced:

| | |
| --- | --- |
| archetype | `task-board` |
| app | https://taskaa20web-2a30.prg1.zerops.app |
| api | https://taskaa20api-2a30-3000.prg1.zerops.app |
| services | `taskaa20db` / `taskaa20api` / `taskaa20web` |

Confirmed independently of the job row: frontend serves 200; the generated `config.js`
carries the api URL Zepit resolved at runtime plus the personalization fields; the api
reports `boardTitle: "Platform Sprint"` from `envSecrets`; and `verify-task-board.js`
passes all five behavior checks against the public URL.

This proves the whole thesis in one run: **archetype selection → infra provisioning →
deploy → subdomain resolution → generated config → behavior verification**, with no
code generated at runtime.

Bugs the real runs caught that the stubs never could have:

- the service list wrapper is `list`/`totalCount`, not `items` — would have failed
  every job at service-id resolution
- service stacks have no top-level `hostname`; it is `name` plus a `userData` entry
- zcli flags are kebab-case (`--project-id`), not camelCase
- `--setup` was missing entirely: the per-job hostname prefix means the hostname can
  never match what a committed `zerops.yaml` declares, so every push would have failed
- the PAT was being echoed into error messages via the `zcli login` command line;
  now redacted at the error boundary
- **the Zerops API times out intermittently from this network** (`connection timed
  out`, and `io: read/write on closed pipe` mid-upload). Two otherwise-healthy jobs
  died this way before retry/backoff was added. This is the single biggest demo-day
  risk — it is not a code bug and cannot be fixed in code beyond retrying.

## Step 4: the backend (written 2026-08-07)

```
backend/
  src/index.js         Express API + boot (schema init, zcli login, orphan sweep)
  src/worker.js        serial claim-and-run loop
  src/orchestrator.js  PIPELINE.md steps 1-9, in order
  src/zerops.js        zcli exec wrapper + REST client + ACTIVE polling
  src/catalog.js       manifest loading, field validation, {{...}} render, job dirs
  src/db.js jobs.js    job table + state transitions
  zerops.yaml          for deploying Zepit itself (step 6)
```

Endpoints: `POST /api/deploy` (202 + job id), `GET /api/jobs/:id`, `GET /api/jobs`,
`GET /api/archetypes`, `GET /healthz`. Archetype is hard-coded via `ZEPIT_ARCHETYPE`;
step 5 replaces that constant with the LLM call and nothing else.

**Two design changes made while building:**

- **Per-job hostname prefix.** Two jobs importing into one project would both create
  `chatapi` and collide. Hostnames are now `{{prefix}}db` / `{{prefix}}api` /
  `{{prefix}}web` with a random 4-char suffix, so jobs are isolated *and*
  hostname → serviceStackId lookup after import is unambiguous. This keeps step 4 on
  the validated `service-import` path instead of switching to fresh-project-per-job,
  which is unvalidated. Revisit when per-request teardown is designed.
- **Serial worker.** One job at a time — zcli holds one machine-wide credential and
  concurrent pushes are not known to be safe. Throughput isn't the demo constraint.

**Verified offline** (real backend, real Postgres, stubbed zcli + stubbed Zerops REST
API that derives its state from the zcli call trace, so it enforces real ordering):

- happy path reaches `live` with the correct call order — import → push api →
  enable-subdomain api → push web → enable-subdomain web → health check
- generated `config.js` carries the resolved api URL and the personalization fields
- field validation: defaults, enum rejection, maxLength, control chars, unknown keys,
  and YAML escaping of quotes/backslashes
- push failure → job `failed`, with zcli's own stderr captured in `error`
- health-check failure → job `failed` **even though both URLs resolved** (golden rule)

That test also caught the flags being wrong: `--projectId` → `--project-id`,
`--serviceId` → `--service-id`, `--workingDir` → `--working-dir`, confirmed against
`zcli --help` v1.1.0. The stub now rejects unknown flags.

**Not yet verified: any of it against real Zerops.** The API was unreachable from the
dev machine all session (`dial tcp 93.185.106.129:443: connect: connection timed out`
to `api.app-prg1.zerops.io`; npm and Docker Hub were fine, so it is Zerops-specific,
not the network). Everything above is stub-verified only. Specifically unproven:
`zcli service-import` accepting a rendered multi-service YAML non-interactively;
whether zcli prompts for anything without a TTY; the exact shape of
`GET /project/<id>/service-stack`; and whether `{{prefix}}` hostnames break any
assumption the hand-run didn't exercise. **Do not treat step 4 as done until one real
job reaches `live`.**

## Archetype 2: `task-board` — built 2026-08-07, not yet deployed

Kanban board, todo/doing/done, cards persist and move. Same three-service shape as
`realtime-chat` (static + nodejs@22 + postgresql:single@16), REST instead of
WebSockets. Fields: `boardTitle`, `ownerName`, `theme`.

Verified locally: the API ran against a real Postgres with real env-var
personalization, and `scripts/verify-task-board.js` passed all five checks — healthz
reports the personalized title, a card persists, a column move persists, a delete
removes it, each read back through a fresh request rather than trusting the write's
own response. Then driven through the orchestrator against the stubs: correct call
order, correct `--setup`, correct generated `config.js`.

Not deployed to Zerops yet — same blocker as step 4.

**Two bugs the second archetype exposed, both now fixed:**

- **`--setup` was missing from `service push`.** zcli defaults the setup name to the
  service hostname, and the per-job prefix means the hostname (`taskb41capi`) can
  never match what a committed `zerops.yaml` declares (`taskapi`). Every push would
  have failed. Manifests now carry `setup` per service and the orchestrator passes it
  explicitly. This would have broken `realtime-chat` too — the hand-run predates the
  prefix change and so never hit it.
- **`config.js` generation was chat-specific**, hardcoding `appTitle`/`room`/`theme`.
  It now emits the api URL plus every manifest field verbatim, so archetypes 3 and 4
  need no orchestrator change. `realtime-chat`'s frontend was updated to read
  `roomName` (its manifest field name) instead of `room`.

## Archetype roadmap — four, decided 2026-08-07

The pipeline is archetype-agnostic, so each additional archetype costs app code +
`manifest.json` + a health check, not new provisioning work. They are ordered by
infra risk: each one after the first introduces at most one unvalidated service type.

| # | id | services | what it proves | new infra risk |
| --- | --- | --- | --- | --- |
| 1 | `realtime-chat` | static + nodejs + postgres | validated end to end | none |
| 2 | `task-board` | static + nodejs + postgres | matcher picks a different *app*, same shape | none — **built 2026-08-07** |
| 3 | `link-shortener` | static + nodejs + postgres + **valkey@7.2** | matcher picks a different *infra shape* | none — **built 2026-08-08**, valkey pre-validated |
| 4 | `media-gallery` | static + nodejs + postgres + **object-storage** | uploads, visually obvious in a demo | object-storage |

Build order is strictly 2 → 3 → 4, and only after plan steps 4–6 are green end to end.
Cut from the back if the clock runs out: #4 first, then #3. Shipping three that work
beats four where one is broken in front of a judge.

**#3 and #4 each provision a service type never validated by hand.** Do the
PIPELINE.md trial-by-hand on `valkey@7.2` and on `object-storage` *before* wiring
either into the orchestrator — discovering their gotchas from inside a job run is how
step 4 turns into a lost day. Open questions to settle during that trial: what env
vars valkey exposes for auth, and whether object-storage credentials resolve through
`envSecrets` cross-service refs the same way `${chatdb_*}` does.

Differentiation is the point: re-skinning one archetype via `appTitle`/`theme` produces
four copies of the same app and reads to a judge as a template renderer. Each archetype
must be a genuinely different app, and #3/#4 must provision genuinely different services.

## Open items

Carried over from plan.txt §12, minus what's now settled:

- **Rotate the PAT before the repo goes public** — the current token was pasted into a
  chat transcript. Regenerate in Access Tokens; keep it in an env var, never committed.
- Create a **separate clean project for Zepit itself** (sandbox `Zip-it` stays throwaway).
- Sandbox services are **still running and billing**. Tear down with
  `zcli service delete -S <id> --confirm` when done experimenting.
- Stack input: free text vs constrained dropdown (recommendation stands: dropdown).
- ~~How many archetypes to ship~~ — **settled 2026-08-07: four.** See the archetype
  roadmap above. Still gated on steps 4–6 being green first.
- ~~Validate `valkey@7.2`~~ — **done 2026-08-08, archetype 3 is unblocked.** See
  PIPELINE.md "Confirmed facts". Validate `object-storage` before archetype 4.
- Per-request teardown / credit budget strategy for demo runs.
- ~~Which LLM/API for the classification call~~ — **settled 2026-08-08: either.**
  `backend/src/llm.js` picks from the key that's present; Gemini is the one with a key.
- Confirm hackathon registration is under the same account being built on
  (`thakur34980@gmail.com`) — confirmed by user, no action.

## Step 5: the classifier (written 2026-08-07, untested)

`backend/src/classifier.js` — one structured, schema-constrained call.
The JSON schema is **generated from the manifests**: an `anyOf` branch per archetype,
each with `const` archetype id, that archetype's exact fields, enums for enum fields,
and `additionalProperties: false`. The model cannot invent an archetype, add a field,
or return an off-enum value — generation is constrained to the shape. Archetypes 3
and 4 appear automatically when their manifests land; there is no second place to
update. Field values are still re-validated server-side, because the schema
constrains shape and enums but not string length.

Archetype resolution on `POST /api/deploy`, in order: explicit choice → classifier
(only when a description was sent and a key is configured) → hard-coded default.
Classification failures are logged and swallowed. **Verified with no API key:**
`/api/classify` returns a clean 400 and `/api/deploy` still queues a job on the
fallback archetype. A broken LLM cannot take down the deploy path — which matters
because the deploy path is the part that's proven.

### Two providers, one seam (added 2026-08-08)

`backend/src/llm.js` is the only file that knows a vendor exists. It exposes one
function — `complete({system, user, schema})` → `{text, model, usage}` — and picks the
provider from whichever API key is present: `GEMINI_API_KEY` → `gemini-2.5-flash`,
`ANTHROPIC_API_KEY` → `claude-opus-5`. `ZEPIT_LLM_PROVIDER` breaks a tie, and
`ZEPIT_LLM_MODEL` overrides the model. The classifier is unchanged by any of this;
it builds the schema and parses the JSON, exactly as before.

The one real difference between providers is the schema dialect. Gemini's
`responseSchema` is an OpenAPI 3.0 subset with **no `const` and no
`additionalProperties`**, so `toGeminiSchema()` rewrites `const: "x"` into
`type: "string", enum: ["x"]`, drops `additionalProperties`, and pins
`propertyOrdering`. Anthropic keeps the strict dialect. Gemini needs no SDK — it is a
`fetch` against `generativelanguage.googleapis.com`, and the Anthropic SDK is now
`require`d lazily so a Gemini-only container never needs it installed.

**Verified 2026-08-08 against the real Gemini API.** `node scripts/verify-classifier.js`
— 3/3 cases matched the expected archetype in ~2.6s each, ~370 in / ~250 out tokens.
Field extraction is good: "a dark-themed message board for the Rust community called
rustaceans" produced `{appTitle: "Rustaceans", roomName: "Rust Community Chat", theme:
"dark"}`. Through the running server, `POST /api/classify` returns the same, and
`/healthz` reports `llm: "gemini:gemini-2.5-flash"`.

The deliberate no-match case behaves as designed — "an image gallery with facial
recognition search" returns `task-board` with *"does not directly match any available
archetype, but task-board is the closest option"*. The UI shows that sentence, so the
user is told when the match is weak rather than being handed a silent mismatch.

The failure branches were verified earlier against a stub endpoint
(`ZEPIT_GEMINI_BASE_URL` points anywhere, which is what made them testable): HTTP 400,
blocked prompt, `MAX_TOKENS`, and no key each surface as a `ClassificationError` with a
readable message, and Gemini's `parts[].thought` reasoning is filtered out before the
JSON parse.

Cost is roughly half a cent per classification on Opus and effectively free on Gemini
Flash's free tier. Both APIs bill separately from any chat subscription.

## ZEPIT IS LIVE ON ZEROPS — 2026-08-07

The submission URL, satisfying the hackathon's hard requirement:

| | |
| --- | --- |
| **UI (submit this)** | https://zepitweb-2a81.prg1.zerops.app |
| API | https://zepitapi-2a81-3000.prg1.zerops.app |
| project | `zepit` — `BRxBWkuXRni22hMwaiKR0g` |
| services | `zepitdb` `WqdXAJmfSSKts0zrvmB48Q` / `zepitapi` `B8Bc9yJ5RmuvdUs54NdL1A` / `zepitweb` `yRtA2oOzSz6rwRAkhJ4Jqw` |

Verified live: UI serves 200 with its generated `config.js`; the API reports `db: up`;
the cross-origin `/api/archetypes` call the UI makes on load returns both archetypes.

**Two secrets still MISSING on `zepitapi`** — set them in the GUI or deploys fail:
`ZEPIT_ZEROPS_TOKEN` (rotate the PAT first) and `ZEPIT_ZEROPS_PROJECT_ID`
(= `hhwmCH9nQ2uo77MnFRCAcg`, so demo deploys land in the sandbox, not the submission
project). `/healthz` reports both as `MISSING` until they are set.

### Three findings from deploying Zepit itself

- **`ZEROPS_` is a reserved env-var prefix.** A custom variable using it is rejected
  with `userDataZeropsPrefixForbidden` and **the entire import fails** — same class of
  trap as `envVariables`, but loud instead of silent. The credentials are now
  `ZEPIT_ZEROPS_TOKEN` / `ZEPIT_ZEROPS_PROJECT_ID`; the backend reads either name so
  local `.env` files keep working.
- **`npm i -g @zerops/zcli` works in a nodejs@22 runtime container.** This was the
  open risk in the whole step-6 design — the orchestrator shells out to zcli from
  inside Zerops. Confirmed in the build log.
- **Gotcha 2 applies to Zepit's own frontend too.** `enable-subdomain` ran while the
  static service was still deploying, errored, and left a subdomain that served 502.
  Re-running it after the deploy finished fixed it. The service reaching `ACTIVE` is
  not the same as its deploy having finished — wait for the push to exit, not just
  for the status.

Also fixed: Zepit's backend had **no CORS headers**, which the archetype APIs have.
On Zerops the UI is a separate origin, so every call from it would have been blocked.

## Step 6: packaging solved (2026-08-07)

The blocker — `backend/zerops.yaml` couldn't ship `templates/` and `scripts/` from
below them — is fixed by building **from the repository root**:

- `zerops.yaml` (root, setup `zepitapi`) — `deployFiles: [backend, templates, scripts]`,
  builds with `cd backend && npm ci --omit=dev`, strips template `node_modules`
  (templates ship as source; the target service's own build installs their deps),
  starts `node backend/src/index.js`. `backend/zerops.yaml` is deleted.
- `frontend/zerops.yaml` (setup `zepitweb`) — unchanged, pushed from `frontend/`.
- `import.zepit.yaml` — Zepit's own three services, with `minContainers/maxContainers: 1`
  on the api so only one serial worker ever runs, and `ZEPIT_SERVE_UI=false` since the
  UI is its own static service here.

Verified locally: the backend starts from the repo root, resolves both archetypes
through root-relative paths, and correctly stops serving the UI under
`ZEPIT_SERVE_UI=false`.

**Still unverified: `npm i -g @zerops/zcli` in the runtime container.** If that fails,
every job fails at the first shell-out. It is the first thing to check on the first
real deploy of Zepit itself.

## THE WHOLE THING WORKS — 2026-08-08 01:23 IST

**Zepit ran end to end from inside Zerops, driven by Gemini, in 97 seconds.**

`POST /api/deploy` with a description and no archetype:
*"a dark-themed live chat room for the Zerops hackathon judges, called Judges Lounge"*

```
classified  realtime-chat via gemini-2.5-flash
            {appTitle: "Zerops Hackathon Chat", roomName: "Judges Lounge", theme: "dark"}
01:22:06    provisioning → importing
01:22:22    building → pushing:chat07a8api
01:23:10    building → pushing:chat07a8web
01:23:43    live      https://chat07a8web-2a81.prg1.zerops.app
```

Independently verified, not trusted from the job status: frontend 200; the generated
`config.js` carries the runtime-resolved `apiUrl` plus all three personalization
fields; the api's own `/healthz` echoes them back from `envSecrets`; and all four
`verify-realtime-chat.js` behavior checks pass against the public URL — websocket
upgrade on two clients, broadcast between them, and 2 rows persisted in Postgres.

This closes the last unproven path: **the orchestrator shelling out to `zcli` from
inside the runtime container**, flagged UNVERIFIED in `zerops.yaml` since step 6.

### How the credentials finally got set (worth knowing, cost ~40 minutes)

Editing `import.zepit.yaml` after the import does nothing — the YAML is applied once,
at import time, and the running service reads Zerops' own stored copy. The GUI edits
silently failed to commit (proof: `lastUpdate` on both entries stayed at the import
timestamp `2026-08-07T08:00:35Z` across two forced restarts). `zcli` has no env
command. What worked was the REST API, one entry at a time:

```
GET /service-stack/{serviceId}/env    -> {items: [{id, key, content, type, ...}]}
PUT /user-data/{entryId}  {key, content}   -> 200
```

Each variable is a separately addressable resource, so a write touches exactly one
entry. There is **no create endpoint at `POST /user-data`** (404) — to add
`GEMINI_API_KEY`, which the original import never created, the empty
`ANTHROPIC_API_KEY` entry was renamed via the same PUT. Env changes need an explicit
`zcli service stop` + `start`; they do not apply on their own.

## Archetype 3: link-shortener (built 2026-08-08)

`templates/link-shortener/` — **four** services: postgres + **valkey@7.2** + nodejs +
static. This is the archetype that proves the matcher picks a different *infrastructure
shape*, not just different HTML.

Valkey is genuinely in the request path, not decorative:

- `GET /:slug` checks Valkey, falls back to Postgres on a miss, warms the cache, 302s.
- Click counts are `INCR`ed **in Valkey** and merged with the durable Postgres baseline
  on read — so a cache hit never touches Postgres at all, which is the entire point.
- `GET /api/resolve/:slug` does the same lookup but returns JSON with `cache: hit|miss`
  and `lookupMs`. It exists because a cross-origin 302 is opaque to `fetch()`, so the
  UI could not otherwise show which store answered. The frontend's *test resolve*
  button drives it: press twice, watch `postgres read 4ms` become `valkey hit 0.6ms`.

**The cache is a soft dependency by design.** Every read falls back, every write is
best-effort, and `/healthz` reports `cache: up|down`. Verified by stopping Valkey
mid-session: resolves, redirects, creates and lists all kept working on Postgres alone,
`/healthz` flipped to `cache: "down"`, and node-redis reconnected on its own when the
container came back — one log line for the whole outage, no restart.

`verify-link-shortener.js` asserts the part that matters: first resolve **MISS**,
second resolve **HIT**, a real 302 with the right `location`, click counts surviving
the Valkey→Postgres merge, and deletion clearing **both** stores (a deleted link that
kept redirecting until its TTL expired would be the obvious bug here). Locally: 7/7,
with the hit at 0.64ms against 4.11ms for the Postgres read.

Also hardened, since a shortener that emits arbitrary schemes is a redirect gadget:
`javascript:` and `data:` URLs rejected, relative URLs rejected, custom slugs
constrained to `[A-Za-z0-9_-]{3,32}`, reserved paths (`api`, `healthz`, …) refused,
duplicate slugs 409, and the slug alphabet drops `0/O/1/l/I` so short links survive
being read aloud.

**One orchestrator change was required.** It waited only on the service whose role was
literally `database`, so the api push would have raced Valkey's provisioning. It now
waits for every service with no `dir` to push — databases and caches alike. The two
existing archetypes are unaffected; they each have exactly one such service.

## All three archetypes deployed and recorded — 2026-08-08

Every archetype has now been deployed through the live UI on Zerops and recorded.
`link-shortener` was verified against its **live** deployment, not just Docker:

```
PASS: /healthz ok (site "Business Link Shortener", db up, cache up)
PASS: first resolve is a cache MISS (2.39ms, from postgres)
PASS: second resolve is a cache HIT (0.81ms, from valkey)
PASS: /WYCekD redirects 302 -> target
PASS: clicks counted through valkey and merged on read (3)
PASS: delete removed it from postgres AND invalidated the cache
```

That `cache: up` closes the last open risk: `VALKEY_URL: ${...kv_connectionString}`
interpolates correctly through a *rendered* template, not just a hand-written YAML.

**`link76d2` is kept alive deliberately** as a clickable exhibit for judges —
https://link76d2web-2a81.prg1.zerops.app. Its *test resolve* button shows the Valkey
hit/miss transition live, which is stronger evidence than the video. Delete it after
judging: `link76d2api/db/kv/web` in project `zepit`.

Teardown done: 30 services deleted across both projects. `zepit` holds 8 (Zepit's own
three, the four-service exhibit, and `core`); `Zip-it` is empty but retained.

### Bug found during teardown: the service list was silently truncated

`GET /project/{id}/service-stack` **pages at 20 and does not say so** — `list` came back
with 20 entries while `totalCount` read 23, and `zepitapi`, `zepitdb` and `core` were
simply absent. `listProjectServices` returned that truncated page as if it were the
whole project.

This was not cosmetic. `orchestrator.js` resolves hostname → serviceStackId from this
exact list, so in any project holding more than 20 services a freshly imported service
could fall off the page and the job would fail with a bogus *"imported service X not
found in project"*. `zepit` was at 23 when this was found; the next deploy into it was
a coin flip. Earlier deploys survived only because new services happened to sort early.

Fixed by paging with `?limit=100&offset=N` until `totalCount` is satisfied, rather than
trusting a single request.

## Secret audit before publishing — 2026-08-08

`node scratchpad/scan.js` checks every file against the *live* values of every
credential-named variable in `backend/.env`, plus generic patterns (`sk-`, `AIza`,
`AQ.`, `ghp_`, PEM blocks, credential-shaped assignments). Result:

```
checking for 2 credential value(s): ZEPIT_ZEROPS_TOKEN, GEMINI_API_KEY
ok  backend/.env:3   the live value of ZEPIT_ZEROPS_TOKEN (gitignored)
ok  backend/.env:20  the live value of GEMINI_API_KEY (gitignored)
clean: no credential appears outside gitignored files
```

53 files scanned. The only occurrences are in `backend/.env`, which `.gitignore`
covers. A first pass also matched `realtime-chat` — the *value* of `ZEPIT_ARCHETYPE` —
across 34 files; matching on value alone is noise, so the scan keys on variables whose
**name** says credential.

**Separately, the deploy artefact was leaking.** `zcli service push --no-git` uploads
the entire working directory as-is — `.gitignore` is not consulted — so `backend/.env`
went up on every push, and since `deployFiles` includes `backend`, the PAT was written
to disk inside the running container. Not web-reachable (`ZEPIT_SERVE_UI=false`), but
it had no business being there. Fixed with `.deployignore`, and **verified by auditing
the archive** (`--archive-file-path`) rather than assuming: the artefact now contains
`backend/.env.example` and no `.env`.

That fix broke production for nine minutes first. `node_modules/` in `.deployignore`
looked like an obvious upload optimisation — but the file is applied a *second* time
when `deployFiles` is collected after the build, so it stripped the `npm ci` output and
the service 502'd on `Cannot find module 'express'`. See PIPELINE.md gotcha 5.

## Match grading + description-first UI — 2026-08-08

The landing page used to open with all three archetype cards, which advertises the size
of the catalogue before the product has said anything. It now opens with one description
box; the archetypes live behind *"or choose an archetype yourself"* and are never shown
unless asked for.

Hiding them is only safe because the model now grades its own match. The classifier
schema gained two fields alongside `reasoning`:

- **`match`** — `strong` | `partial` | `none`
- **`requested`** — a short noun phrase for what the user actually asked for

Without that grade, hiding the catalogue would turn "e-commerce store with Stripe" into a
Kanban board with no explanation — a silent bait-and-switch, worse than looking limited.
With it, each grade renders as a distinct state:

| grade | UI |
| --- | --- |
| `strong` | green — "Matched realtime-chat" + reasoning, normal **Deploy** |
| `partial` | amber — "Partial match" + what the archetype does *not* do |
| `none` | red — "Zepit can't build *an online store* yet", the catalogue auto-reveals, and the button reads **Deploy task-board anyway** with "It won't be what you asked for" |

The `none` state is the strongest thing to show a judge who goes off-script: the product
knows its own boundary and says so, instead of quietly deploying the wrong app.

**Grading verified against the real Gemini API — 8/8**, in-scope and out-of-scope both,
so the model is neither flattering every request nor over-correcting real matches:
`strong` for chat/kanban/short-links, `none` for an online store, a photo gallery and an
email-reading AI agent, `partial` for "message board with password sign-up" and "kanban
board that also emails a daily summary". The prompt states outright that an inflated
`strong` is worse than an honest `none`, and `classify()` defaults an unrecognised grade
to `partial` so an unrated match can never render as a confident one.

All three states were screenshotted in headless Chromium against a stub returning the
live API's exact response shape, then the file was confirmed byte-identical to what
`zepitweb` serves.

**Demo-day risk found while testing: the Gemini free tier allows 5 requests/minute.**
Six classifications in a row hit `429 generate_content_free_tier_requests, limit: 5`.
Judges clicking *Match it* repeatedly will hit this. The UI surfaces it as
"Couldn't match: …" and the deploy path is unaffected (`/api/deploy` swallows
classification failures and falls back), but consider enabling billing on the Gemini key
before judging, or pre-recording the match step.

## Next action

The product works. Everything below is submission work.

Done: ~~secrets out of the YAML~~, ~~demo recorded (all three)~~, ~~teardown~~,
~~archetype 3~~, ~~Gemini key live~~.

**1. Submission paperwork.** Demo video, public build post tagging @WeMakeDevs and
@zeropsio, the official form, and the AI-tool disclosure.

**2. Make the repo readable to judges.** It is not a git repo yet — `git init`, commit,
push. `.gitignore` already covers `.env`, `node_modules/`, `.jobs/`. Confirm no PAT is
in the tree before pushing (`import.zepit.yaml` is clean as of 2026-08-08).

**3. Revoke every PAT you are not using.** Two have been issued and both passed through
a chat transcript. Only the one currently in `backend/.env` and on `zepitapi` is needed.

**4. Disclose the single-credential model** in the submission. Zepit provisions with one
operator PAT and has no user accounts — a fine hackathon answer, but say it rather than
let a judge discover it.

**5. After judging:** delete the `link76d2*` exhibit (4 services in `zepit`).

Optional if time remains: archetype 4 (`media-gallery`, +object-storage). Validate
`object-storage` by hand first — same discipline that made valkey a non-event.

For reference, the local run:

```
cd backend && npm ci
cp .env.example .env      # fill ZEROPS_TOKEN, point PG* at a local postgres
npm start
curl -X POST localhost:3000/api/deploy -H 'content-type: application/json' \
  -d '{"fields":{"appTitle":"Acme Support","roomName":"support","theme":"light"}}'
```

Then poll `GET /api/jobs/:id` until `live` or `failed`, and open the returned
`app_url`. Expect the first real run to surface at least one zcli behaviour the stub
got wrong — that's what it's for. Step 5 (the LLM call) only starts after one real
job reaches `live`.
