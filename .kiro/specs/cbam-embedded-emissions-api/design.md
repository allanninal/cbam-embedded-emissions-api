# Design — CBAM Embedded Emissions API

## 1. Architecture overview

One public repo, **two tiers served from one origin** by a Node/Express service, exactly like the
reference projects at `../EUDR-due-diligence` and `../eu-ai-act-provenance`:

- **Static tier (`/api/v1/*`, public, not rate limited):** docs, OpenAPI, reference JSON (sectors,
  CN-code mapping, default values, country factors, carbon-price snapshot, meta, schemas).
- **Compute tier (`/v1/*`, public/free, rate limited):** calculate / declarations-calculate /
  calculation-record endpoints. Anonymous access allowed; optional API keys unlock a higher budget
  and retained calculation history.

The service runs **self-hosted on the shared server** behind the **shared Caddy → APISIX → Redis**
stack it inherits from the reference projects. It does **not** provision its own Redis or gateway.
It is mounted under the **`/cbam`** path prefix and isolates its Redis keys with the **`cbam:rl:`**
(app) and **`cbam:gw:`** (gateway) prefixes.

The CBAM calculation is **pure lookup + arithmetic** over version-pinned reference data — the `$0`
stack, no heavy compute. The Node service handles HTTP, auth/metering, rate limiting, calculation
persistence, and the shared-infra wiring — preserving the reference projects' Node + SQLite +
shared-Redis pattern.

```
Internet :80/:443
   │
   ▼
Caddy (SHARED edge: TLS, body cap, real client IP)
   │  forwards full path (/cbam/...) and X-Forwarded-For
   ▼
APISIX (SHARED gateway, standalone/YAML mode)
   ├── /eudr/*  → eudr-api           (existing project, untouched)
   ├── /c2pa/*  → c2pa-api           (existing project, untouched)
   └── /cbam/*  → cbam-api:8792       (this project)
         • real-ip · proxy-rewrite (strip /cbam) · CORS
         • limit-count policy:redis  redis_prefix "cbam:gw:"  DB 1
   ▼
cbam-api container (expose 8792, NOT published to host)
   ├── /api/v1/*   static reference data + docs (dist/)
   └── /v1/*       compute: calculate · declarations/calculate · calculations/{id} · usage
         │
         ├── SQLite (better-sqlite3): api_keys, usage, calculation_records
         ├── calc engine  (CN→good→default→country factor→certificates→cost)
         └── reference data (version-pinned): cn-codes · default-values ·
              country-factors · sectors · carbon-price snapshot

SHARED Redis (shared-redis): app limiter keys "cbam:rl:" (DB 0),
                             gateway limiter keys "cbam:gw:" (DB 1)
```

### Why this shape
- **The mapping is the product, not the maths.** The engine is deterministic lookup + arithmetic;
  the defensibility comes from a versioned CN→good→factor mapping and a per-line audit trail
  (R1, R2). All emission factors / country factors / thresholds are **data, not code** (R11.4).
- **`$0` stack.** No satellite rasters, no ML, no external heavy compute — a small Node service
  over SQLite + static JSON, so it drops onto the shared VPS with a negligible footprint.
- **Shared infra, zero collision:** path prefix + per-project Redis prefixes mean this project drops
  onto the same server next to EUDR and C2PA without touching their routes or data (R10).
- **Ship the calculator now, registry submission later.** The calculator is what importers need for
  2026 imports; the Commission registry submission API (Q4 2026) is a documented follow-on (R13).

## 2. Data sources (all free / Commission-published)

| Source | Role | License / access |
|---|---|---|
| **Commission default embedded-emission values** | per-good default tCO2e/t used when no verified actual is supplied | free/published (CBAM implementing acts + annexes) |
| **CN-code tables (CBAM Annex I goods)** | CN code → CBAM good → sector mapping | free/published (Combined Nomenclature + CBAM annexes) |
| **Country adjustment factors** | origin-country adjustment to the default value (where defined) | free/published |
| **EU ETS carbon price** | EUR/tCO2e price used to cost certificates | free/public market reference |
| **CBAM Regulation (EU) 2023/956 + implementing acts** | scope, thresholds, dates, rounding, certificate definition | free/published (Official Journal) |

All reference data is **fetched, version-pinned, and cached** in `data/` (source of truth) and
compiled into `dist/api/v1/`, each dataset carrying a `version`, `source` URL, and `effectiveDate`.
The carbon-price snapshot is refreshed on a schedule and stored with an `asOf` timestamp (§6).

## 3. Repository layout
Mirrors the reference projects' workspace + `deploy/` conventions.

```
cbam-embedded-emissions-api/
├── README.md  LICENSE  LICENSE-DATA.md  DISCLAIMER.md  openapi.yaml
├── data/                        # static reference data (source of truth), version-pinned
│   ├── meta.json  sectors.json  cn-codes.json
│   ├── default-values.json  country-factors.json  carbon-price.json
├── schemas/
│   ├── calculate-request.schema.json  calculate-response.schema.json
│   ├── declaration-request.schema.json  calculation-record.schema.json
│   ├── cn-code.schema.json  default-value.schema.json  country-factor.schema.json
├── packages/
│   ├── lib/                     # client lib: calculateLine, validateCalculationRecord, types
│   │   └── src/calculate.mjs  src/validateRecord.mjs  src/index.mjs
│   └── server/                  # self-hosted compute API (Node/Express + SQLite)
│       └── src/
│           ├── server.mjs       # entrypoint: wires store, redis, datasets, carbon price
│           ├── app.mjs          # Express app factory (testable, injectable deps)
│           ├── calc.mjs         # core: cn→good→default→country factor→certificates→cost
│           ├── audit.mjs        # build the per-line audit trail (sources + versions)
│           ├── datasets.mjs     # load/version-pin reference datasets
│           ├── carbon-price.mjs # cached ETS price + scheduled refresh + freshness flag
│           ├── store.mjs        # SQLite: api_keys, usage, calculation_records
│           ├── rate-limit.mjs   # memory/redis fixed-window (from reference projects)
│           └── seed-key.mjs     # issue an API key
├── site/  index.html  styles.css   # docs + live calculator (bundled lib, client-side)
├── src/  build.mjs  validate-data.mjs
├── examples/  calculate.request.json  declaration.request.json  calculation-record.example.json
├── test/  calc.test.mjs  audit.test.mjs  datasets.test.mjs  carbon-price.test.mjs
│         data.test.mjs  api.integration.test.mjs  rate-limit.test.mjs
├── deploy/
│   ├── Caddyfile                # adds /cbam route to the shared edge
│   ├── backup/backup.sh         # daily SQLite .backup (calculation history)
│   └── shared/                  # SAME shared stack as EUDR/C2PA (redis + apisix) — reused, not forked
│       └── apisix/apisix.yaml   # + cbam route block (see §9)
├── Dockerfile  docker-compose.yml  .env.example  .dockerignore
└── .kiro/specs/cbam-embedded-emissions-api/  requirements.md  design.md  tasks.md
```
`dist/` (generated) is served by the Node service as the static tier.

## 4. Endpoints

### Compute tier (`/v1`, public/free, rate limited, optional key)
| Method | Path | Purpose |
|---|---|---|
| POST | `/v1/calculate` | single line → emissions + certificates + cost + audit trail (R1, R2) |
| POST | `/v1/declarations/calculate` | many lines → per-line + aggregate (R3) |
| GET  | `/v1/calculations/{recordId}` | fetch a retained calculation record (key holders) (R5) |
| GET  | `/v1/usage` | current key usage/quota (R9.6) |

### Static tier (`/api/v1`, public, not rate limited)
`index.json`, `meta.json`, `sectors.json`, `cn-codes.json`, `cn-codes/{code}.json`,
`default-values.json`, `country-factors.json`, `carbon-price.json`,
`schemas/calculate-response.schema.json`, `schemas/calculation-record.schema.json`.

## 5. Core data models

### 5.1 Calculate request
```json
{
  "cnCode": "72071110",
  "originCountry": "IN",
  "tonnes": 120.0,
  "importYear": 2026,
  "carbonPrice": null
}
```
Rules: `originCountry` ISO 3166-1 alpha-2; `tonnes` > 0; optional `carbonPrice` (EUR/tCO2e) for
what-if pricing; `importYear` selects the applicable dataset version window.

### 5.2 Calculate response
```json
{
  "cbamGood": "Semi-finished products of iron or non-alloy steel",
  "sector": "iron-steel",
  "inScope": true,
  "basis": "default-values",
  "embeddedEmissions": { "value": 267.6, "unit": "tCO2e" },
  "certificatesOwed": 268,
  "carbonPrice": { "value": 72.14, "currency": "EUR", "asOf": "2026-09-11", "source": "EU ETS" },
  "cost": { "value": 19333.52, "currency": "EUR" },
  "auditTrail": [
    { "step": "cn-mapping", "cnCode": "72071110", "resolvedGood": "...", "sector": "iron-steel",
      "source": "CBAM Annex I", "datasetVersion": "cn-2026.1" },
    { "step": "default-value", "factor": 2.23, "unit": "tCO2e/t",
      "source": "Commission default values", "datasetVersion": "dv-2026.1" },
    { "step": "country-factor", "country": "IN", "factor": 1.0, "applied": "default",
      "source": "country-factors", "datasetVersion": "cf-2026.1" },
    { "step": "emissions", "formula": "tonnes × factor × countryFactor", "value": 267.6, "unit": "tCO2e" },
    { "step": "certificates", "rounding": "round-half-up", "value": 268 },
    { "step": "cost", "formula": "certificates × carbonPrice", "value": 19333.52, "currency": "EUR" }
  ],
  "assessedAt": "2026-09-14T00:00:00Z",
  "datasetVersions": {
    "cnMapping": "cn-2026.1", "defaultValues": "dv-2026.1",
    "countryFactors": "cf-2026.1", "carbonPrice": "2026-09-11", "stale": false
  }
}
```
Out-of-scope / below-threshold example: `inScope: false`, `reason: "out-of-scope" |
"below-de-minimis"`, with the indicative emissions still shown but `certificatesOwed: 0`.

### 5.3 Declaration (bulk) request/response
Request: `{ "lines": [ { cnCode, originCountry, tonnes }, ... ], "importYear": 2026 }`.
Response: `{ "lines": [ <per-line response or per-line error>, ... ], "aggregate": {
totalEmissions, totalCertificates, totalCost, currency, linesInScope, linesOutOfScope,
declarationCrossesDeMinimis } }`. Documented max batch size; partial results on per-line failure
(R3.3); cost = 1 unit/line (R3.4).

### 5.4 Calculation record (`calculation-record.schema.json`) — retained history (R5)
```json
{
  "recordId": "01JD...ULID",
  "input": { "cnCode": "72071110", "originCountry": "IN", "tonnes": 120.0, "importYear": 2026 },
  "cbamGood": "...", "sector": "iron-steel",
  "embeddedEmissions": 267.6, "certificatesOwed": 268,
  "carbonPrice": { "value": 72.14, "asOf": "2026-09-11" },
  "cost": 19333.52, "currency": "EUR",
  "datasetVersions": { "cnMapping": "cn-2026.1", "defaultValues": "dv-2026.1",
                       "countryFactors": "cf-2026.1", "carbonPrice": "2026-09-11" },
  "calculatedAt": "2026-09-14T00:00:00Z",
  "service": { "name": "cbam-embedded-emissions-api", "version": "1.0.0" }
}
```
Inputs + derived metadata only. Reproducible from the record + pinned dataset versions (R2.3, R5.3).

### 5.5 Reference data shapes
- **Sector:** `{ id, name, scopeNote }` — ids: `iron-steel, aluminium, cement, fertilisers,
  hydrogen, electricity`.
- **CN code:** `{ cnCode, good, sector, inScope, source, version }`.
- **Default value:** `{ good, sector, factor, unit: "tCO2e/t", source, version, effectiveDate }`.
- **Country factor:** `{ iso2, factor, source, effectiveDate }`; unlisted ⇒ documented default
  factor (typically 1.0).
- **Carbon price:** `{ value, currency: "EUR", asOf, source, freshnessWindowDays }`.

### 5.6 Meta (`meta.json`)
```json
{
  "regulation": "Regulation (EU) 2023/956 (CBAM)",
  "definitiveRegimeStart": "2026-01-01",
  "certificatePurchaseSurrenderStart": "2027-02",
  "firstAnnualDeclarationDue": "2027-09-30",
  "registryDeclarationCreationOpens": "2026-Q4",
  "deMinimisTonnes": 50,
  "sectors": ["iron-steel", "aluminium", "cement", "fertilisers", "hydrogen", "electricity"],
  "certificateDefinition": "1 CBAM certificate = 1 tonne CO2e embedded emissions",
  "basis": "default-values",
  "datasetVersions": { "cnMapping": "cn-2026.1", "defaultValues": "dv-2026.1",
                       "countryFactors": "cf-2026.1", "carbonPrice": "2026-09-11" },
  "disclaimer": "Estimation and audit-trail tooling using published default values. Not legal advice. Not the official EU CBAM registry. Verified actual emissions require an accredited verifier.",
  "sources": {
    "regulation": "https://eur-lex.europa.eu/eli/reg/2023/956/oj",
    "defaultValues": "https://taxation-customs.ec.europa.eu/carbon-border-adjustment-mechanism_en",
    "cnCodes": "https://taxation-customs.ec.europa.eu/...",
    "etsPrice": "https://...eu-ets-price-reference..."
  }
}
```

## 6. Calculation engine & carbon price (R1, R2, R4)

### 6.1 Calculation (`calc.mjs`) — deterministic lookup + arithmetic
1. **Resolve CN code → CBAM good** via the pinned `cn-codes` table. Unmapped/out-of-scope ⇒
   `inScope: false`, `reason: "out-of-scope"`, no fabricated figure (R1.2).
2. **Default emission factor** for the good from `default-values` (tCO2e/t) (R1.3).
3. **Country factor** for `originCountry` from `country-factors`; unlisted ⇒ documented default
   (R1.3, R6.4).
4. `embeddedEmissions = tonnes × defaultFactor × countryFactor` (tCO2e) (R1.3).
5. `certificatesOwed = round(embeddedEmissions)` per the documented rounding rule (1 cert = 1 tCO2e)
   (R1.4).
6. `carbonPrice` = client-supplied if given (audit `source: "client-supplied"`), else the cached
   ETS price (R4.2). `cost = certificatesOwed × carbonPrice` (EUR) (R1.4).
7. **De-minimis:** if the line/consignment is below the **50-tonne** threshold ⇒ `inScope: false`,
   `reason: "below-de-minimis"`, `certificatesOwed: 0`, indicative emissions still shown (R1.6).
8. Every step is emitted into the **audit trail** with value + source + dataset version (R2).

The engine is a **pure function** of `(input, datasets, carbonPrice)`, so it is identically
reproducible client-side (`packages/lib`) and server-side, and re-running the same input against
the same dataset versions yields an identical result and trail (R2.3, R7.1).

### 6.2 Carbon price (`carbon-price.mjs`, R4)
- A cached **EU ETS price** (EUR/tCO2e) with `asOf` + source lives in `data/carbon-price.json` and
  in memory; a **scheduled refresh** updates it (R4.1, R16.4).
- The definitive-regime pricing basis (e.g. the relevant weekly/average ETS reference) is documented
  in `meta.json`; the exact value + `asOf` always appear in the audit trail (R4.3, R2).
- If the price is older than `freshnessWindowDays`, responses set `datasetVersions.stale = true`
  (R4.4). A failed refresh retains the prior price and flags stale — never a silent outdated price.

### 6.3 Audit trail (`audit.mjs`, R2)
Builds the ordered step list (cn-mapping → default-value → country-factor → emissions → certificates
→ cost), each entry citing `source` + `datasetVersion`, plus the `datasetVersions` summary block, so
the figure is reproducible from the record alone.

## 7. Auth, metering & rate limiting (R9) — reuses the reference projects' code

Identical model to `../EUDR-due-diligence/packages/server` and `../eu-ai-act-provenance`:
- **Public mode** (`REQUIRE_KEY=false`): anonymous allowed; metered by validated key hash, else by
  real client IP. A bearer token only earns its own budget if it validates against the key store
  (unknown tokens can't mint buckets).
- **Rate limiting** is enforced primarily at the **shared APISIX gateway** (`limit-count`
  `policy: redis`, keyed on real client IP, `redis_prefix: cbam:gw:`, DB 1). The app-side
  fixed-window limiter (`rate-limit.mjs`, `redis_prefix: cbam:rl:`, DB 0) is defense-in-depth and
  for non-gateway deploys; it **fails open** if Redis is down.
- **Cost = 1 unit per line** (batch = number of lines), so metering is fair (R9.4).
- **Metering** in SQLite `usage(key_hash, day, calculations, lines)`; per-key daily quota enforced →
  **429** on exceed with `Retry-After` and `RateLimit-*` headers.
- Default anon 60/min + 5,000/day; key holders 5× / 10× (env-configurable), same as reference.

## 8. Persistence (`store.mjs`, SQLite via better-sqlite3)
```sql
CREATE TABLE api_keys (key_hash TEXT PRIMARY KEY, tier TEXT NOT NULL, quota INTEGER,
                       created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE usage (key_hash TEXT NOT NULL, day TEXT NOT NULL,
                    calculations INTEGER NOT NULL DEFAULT 0,
                    lines INTEGER NOT NULL DEFAULT 0,
                    PRIMARY KEY (key_hash, day));
-- Retained calculation history (R5). Inputs + derived metadata only, reproducible from versions.
CREATE TABLE calculation_records (record_id TEXT PRIMARY KEY, key_hash TEXT,
                                  cn_code TEXT NOT NULL, origin_country TEXT NOT NULL,
                                  tonnes REAL NOT NULL, certificates_owed INTEGER NOT NULL,
                                  cost REAL, currency TEXT, record_json TEXT NOT NULL,
                                  created_at TEXT NOT NULL DEFAULT (datetime('now')));
```
WAL + `synchronous=NORMAL` + `busy_timeout`, matching the reference store. Retention window for
`calculation_records` is documented per tier; anonymous calculations return the full record inline
but are not persisted server-side.

## 9. Shared-server integration (R10) — same server, same Redis, same gateway

This project is **added alongside** EUDR and C2PA on the same host; the shared stack in
`../EUDR-due-diligence/deploy/shared/` (one `shared-redis`, one `shared-apisix`, the `shared-net`
network) is **reused as-is**. Nothing about EUDR or C2PA changes.

**Add one route block set** to the shared APISIX table (`deploy/shared/apisix/apisix.yaml`), copying
the existing template. Distinct `uri`, upstream node, and Redis prefix guarantee isolation:

```yaml
  # ---------------- CBAM: static reference API (FREE, not rate limited) ----------------
  - id: cbam-static
    uri: /cbam/api/*
    upstream: { type: roundrobin, nodes: { "cbam-api:8792": 1 } }
    plugins:
      real-ip: { source: http_x_forwarded_for, recursive: true,
                 trusted_addresses: [172.16.0.0/12, 10.0.0.0/8, 192.168.0.0/16] }
      proxy-rewrite: { regex_uri: ["^/cbam/(.*)", "/$1"] }
      cors: { allow_origins: "*", allow_methods: "GET,POST,OPTIONS",
              allow_headers: "authorization,content-type" }

  # ---------------- CBAM: compute API (rate limited via shared Redis) ----------------
  - id: cbam-compute
    uri: /cbam/v1/*
    upstream: { type: roundrobin, nodes: { "cbam-api:8792": 1 } }
    plugins:
      real-ip: { source: http_x_forwarded_for, recursive: true,
                 trusted_addresses: [172.16.0.0/12, 10.0.0.0/8, 192.168.0.0/16] }
      proxy-rewrite: { regex_uri: ["^/cbam/(.*)", "/$1"] }
      limit-count:
        count: 60
        time_window: 60
        rejected_code: 429
        rejected_msg: "rate limit exceeded (gateway)"
        key_type: "var"
        key: "remote_addr"
        policy: redis
        redis_host: "shared-redis"
        redis_port: 6379
        redis_password: "__REDIS_PASSWORD__"   # rendered by shared entrypoint.sh
        redis_database: 1
        redis_prefix: "cbam:gw:"               # ← distinct from eudr:gw: / c2pa:gw:
        show_limit_quota_header: true
        allow_degradation: true                 # fail open if Redis down
      cors: { allow_origins: "*", allow_methods: "GET,POST,OPTIONS",
              allow_headers: "authorization,content-type" }

  # site catch-all + bare-/cbam redirect: mirror eudr-site / eudr-root-redirect
```

**Caddy:** add a `/cbam/*` handle to `deploy/Caddyfile` (or extend the shared Caddyfile) that
proxies to `shared-apisix:9080`, forwarding the client IP — same pattern as `/eudr/*` and `/c2pa/*`.
The homepage listing gains a `/cbam/` line.

**Redis isolation summary:**
| Concern | EUDR | C2PA | CBAM (this project) |
|---|---|---|---|
| App limiter prefix (DB 0) | `eudr:rl:` | `c2pa:rl:` | `cbam:rl:` |
| Gateway limiter prefix (DB 1) | `eudr:gw:` | `c2pa:gw:` | `cbam:gw:` |
| Path prefix | `/eudr` | `/c2pa` | `/cbam` |
| Upstream node | `eudr-api:8787` | `c2pa-api:8790` | `cbam-api:8792` |

`docker compose -f deploy/shared/docker-compose.yml restart apisix` after editing the route table.
No change to Redis or the network is needed.

## 10. Container & compose (R15) — mirrors the reference projects
- **Dockerfile:** multi-stage. Stage 1 builds the static `dist/` and installs prod deps. Runtime
  stage is `node:20.18.1-bookworm-slim`, **non-root** (`node` user), **read-only root fs**, writable
  `/data` volume + `/tmp` tmpfs, `cap_drop: ALL`, `no-new-privileges`, healthcheck hitting
  `/healthz`. Base images pinned (node/redis/caddy/apisix), matching the reference projects.
- **docker-compose.yml:** `cbam-api` (build with `BASE_PATH=/cbam`, `expose: 8792`, joins
  `cbam-net` + external `shared-net`, CPU/memory limits, `REQUIRE_KEY=false`, `RATE_LIMIT=false`,
  `REDIS_URL=redis://:${REDIS_PASSWORD}@shared-redis:6379/0`, `REDIS_PREFIX=cbam:rl:`,
  `CARBON_PRICE_REFRESH_CRON`, `TRUST_PROXY=1`), the shared `caddy`, and a `backup` service
  snapshotting the SQLite calculation DB daily. The app is **not published to the host** — reachable
  only via Caddy → APISIX (R10.1).

## 11. Client library & docs site (R7, R8, R14)
- `packages/lib`: `calculateLine(input, datasets)` (the same pure engine as the server) and
  `validateCalculationRecord(record, datasets)` for offline reproduction/verification, plus the
  verdict/type definitions.
- `site/`: docs with `curl`/`fetch` examples and a **live calculator** (enter CN code + origin +
  tonnes → emissions / certificates / cost, with the audit trail shown) running the bundled library
  client-side for a zero-backend demo (the API is what brokers/ERPs integrate).
- Licensing: **MIT** code; `LICENSE-DATA.md` covers redistribution of Commission-published data +
  attribution; `DISCLAIMER.md` carries the not-legal-advice / not-official-registry / default-value
  language.

## 12. Scope discipline & the deferred registry submission (R12, R13)
- **v1 is the calculator only.** It computes default-value embedded emissions, certificates owed,
  and cost with a per-line audit trail. Every response records `basis: "default-values"` and notes
  that verified actuals require an accredited verifier (R12.1).
- **Registry submission is deferred (R13).** When the Commission's CBAM registry declaration API
  opens (Q4 2026), a future `POST /v1/declarations/submit` maps the calculation + audit trail onto
  the registry submission format. The mapping shape is documented here as a planned follow-on; it is
  **out of scope for v1**. No code path in v1 submits to the registry or asserts authorised-declarant
  status.

## 13. Testing (R15) — mirrors the reference projects' node:test approach
- **Unit:** calculation correctness incl. rounding + country factor + de-minimis (`calc.test.mjs`),
  audit-trail completeness + reproducibility (`audit.test.mjs`), dataset load/version-pin
  (`datasets.test.mjs`), carbon-price freshness/stale flag (`carbon-price.test.mjs`), reference data
  valid against schemas (`data.test.mjs`), rate-limit windows (`rate-limit.test.mjs`).
- **Integration:** boot the Express app in-process with in-memory backend; exercise the HTTP surface
  (calculate, out-of-scope CN, below-de-minimis, bad ISO2 400, declaration bulk + partial results,
  429).
- **CI:** validate data (fail on invalid) → unit+integration tests (Node 20) → build → build the
  Docker image → Docker-based E2E smoke against the built image (`GET /cbam/api/v1/index.json`,
  `POST /cbam/v1/calculate`).

## 14. Notes on the shared-server request
This API drops onto the **same shared server** as EUDR and C2PA and reuses the **same Caddy, APISIX,
and Redis** with zero collision (path prefix `/cbam`, Redis prefixes `cbam:rl:` / `cbam:gw:`,
upstream `cbam-api:8792`). The shared stack in `deploy/shared/` is not forked — one route block is
added and APISIX is reloaded. Adding CBAM changes nothing about the two existing projects.
