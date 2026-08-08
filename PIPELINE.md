# Validated Zerops pipeline (proven against the `Zip-it` sandbox, 2026-08-06)

This is the exact sequence Zepit's backend must implement. It differs from the
original plan in three places — all found by running it by hand.

## Order of operations (per job)

1. Copy `templates/<archetype>/` to a per-job working dir. Never mutate the template.
2. Render `import.template.yaml` (`{{field}}` substitution) → `import.yaml`.
3. `zcli project service-import <import.yaml> --project-id <id>`
   (or `project project-import` for a fresh project). Databases come up `ACTIVE`;
   runtime services land in `READY_TO_DEPLOY`.
4. `zcli service push -P <project> -S <apiServiceId> --working-dir <job>/api --no-git`
5. `zcli service enable-subdomain -P <project> -S <apiServiceId>` — **only works after
   step 4**, see gotcha 2.
6. Read the api's public URL from `zeropsSubdomain` (see "Reading the URL" below).
7. Write `<job>/frontend/config.js` with that URL + the personalization fields.
8. `zcli service push ... --working-dir <job>/frontend --no-git`, then
   `zcli service enable-subdomain` on the frontend.
9. Run the archetype's behavior health check. Only then report the URL.

## Gotchas found (each one silently produced a broken deploy)

**1. `envVariables` is not a valid service-level key in an import YAML.**
It is accepted without warning and then completely ignored — the keys simply do
not exist on the service. `envVariables` only exists *inside* `zerops.yaml`, under
`build:` / `run:`. For per-request personalization the import-level key is
**`envSecrets`**, which does work and does resolve cross-service refs like
`${chatdb_hostname}`. Symptom if you get this wrong: `pg` falls back to
`127.0.0.1:5432` → `ECONNREFUSED` → 502 at the subdomain.

**2. `enableSubdomainAccess: true` in the import YAML did not take effect**
(`subdomainAccess` stayed `false`). Worse, you cannot enable it before the first
successful deploy — an undeployed service returns `serviceStackIsReadyToDeploy`,
and a service with no HTTP port returns `serviceStackIsNotHttp` (ports are only
registered from `zerops.yaml` at deploy time). So: **push first, then
`zcli service enable-subdomain` explicitly.** Do not rely on the YAML flag.

**3. The frontend cannot learn the API URL at build time.** The api subdomain does
not exist until after step 5, so `${chatapi_zeropsSubdomain}` is empty when the
frontend builds. Fix: resolve the URL in the orchestrator and write a generated
`config.js` into the job dir before pushing the frontend. No build-time `sed`, no
cross-service reference, no source edit.

**4. `npm ci` needs a committed `package-lock.json`.** Without it the build fails
outright. Lockfiles are committed for every template.

**5. `.deployignore` is applied TWICE, and `node_modules` in it is fatal.**
`zcli service push --no-git` uploads the whole working directory as-is — `.gitignore`
is not consulted, so `backend/.env` ships unless `.deployignore` excludes it. But the
same file is applied a *second* time when `deployFiles` is collected **after** the
build, so listing `node_modules/` there strips the `npm ci` output out of the artefact
and the service dies on `Cannot find module 'express'` with a 502. Exclude `.env`;
never exclude `node_modules`.

**6. `ZEROPS_` is a reserved prefix for custom variables.** A single `envSecrets`
entry named `ZEROPS_TOKEN` gets the **entire import rejected** with
`userDataZeropsPrefixForbidden` — not the one key, the whole file. Prefix your own
variables with something else; Zepit uses `ZEPIT_ZEROPS_*`.

**7. Import YAML applies once, at import time.** Editing it afterwards changes
nothing on a running service — the service reads Zerops' own stored copy. `zcli` has
no env command either, so the only ways to change a variable later are the GUI or
the REST API:

```
GET /service-stack/{serviceId}/env    -> {items: [{id, key, content, type, ...}]}
PUT /user-data/{entryId}  {key, content}   -> 200
```

Each variable is a separately addressable resource, so a write touches exactly one
entry. There is no create endpoint (`POST /user-data` → 404) — to add a variable the
import never declared, rename an existing unused entry with the same `PUT`. Changes
need an explicit `zcli service stop` + `start`; they do not apply on their own.

## Reading the URL

`zcli` has no command for this. Use the REST API with the same PAT:

```
GET https://api.app-prg1.zerops.io/api/rest/public/service-stack/<serviceId>
Authorization: Bearer <token>
```

The public URL is in `userData[]` under key `zeropsSubdomain`
(e.g. `https://chatapi-2a30-3000.prg1.zerops.app` — note the port is in the host).
`status` on the same object is the deploy state to poll (`ACTIVE` when running).
`envSecrets` values are **not** returned here, so verify them via the app's own
`/healthz`, not the API.

## Confirmed facts

- Type strings: `nodejs@22`, `postgresql:single@16`, `static`, `valkey@7.2`.
  Mode is part of the type string; there is no separate `mode:` for postgres.
- Postgres exposes `hostname`, `port` (5432), `portTls` (6432), `user`, `password`,
  `dbName` (= `db`), `superUser`, `superUserPassword`.
- Setting `PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE` lets `pg` self-configure.
- **`connectionString` is stored as a literal template but resolves on injection.**
  Reading it off the service shows `redis://default:${password}@${hostname}.zerops:${port}`
  verbatim, which looks unusable — but referencing it from a sibling service as
  `${vktest_connectionString}` delivers it fully interpolated, nested placeholders
  and all. Verified for valkey 2026-08-08; the same is likely true of postgres, which
  is why the discrete `PG*` vars are a choice here rather than a necessity.
- **valkey@7.2 — validated 2026-08-08** with a throwaway service pair, since no
  archetype may depend on an unverified service type.
  - Exposes `hostname`, `port` (6379), `portTls` (6380), `portReplicas` (7000),
    `portTlsReplicas` (7001), `password` (32 chars), `connectionString`.
  - **AUTH is mandatory** — user `default`, the injected password. Unlike postgres
    there is no unauthenticated path.
  - Both `vktest` and `vktest.zerops` resolve from a sibling service.
  - Came up ACTIVE in ~30s. `AUTH` / `SET … EX` / `GET` / `INCR` / `TTL` all verified
    over a raw socket, and `INCR` returned 1 then 2 across two separate connections,
    so state persists as expected.
- WebSockets need no special config: one port with `httpSupport: true`, `ws` rides
  the same `http.Server`. Verified through the public subdomain (wss works).
- Teardown works: `zcli service delete -S <id> --confirm`.

## Verified state in the sandbox

Project `Zip-it` (`hhwmCH9nQ2uo77MnFRCAcg`), org `E5b1eBqQRjKv9VW0rw3ABA`:

| service | type | URL |
| --- | --- | --- |
| chatdb | postgresql:single@16 | private |
| chatapi | nodejs@22 | https://chatapi-2a30-3000.prg1.zerops.app |
| chatweb | static | https://chatweb-2a30.prg1.zerops.app |

Behavior check passed: WS upgrade (2 clients) → broadcast → row persisted in
Postgres. See `scripts/verify-realtime-chat.js`.
