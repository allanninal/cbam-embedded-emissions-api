# Tasks — CBAM Embedded Emissions API

One repo, **two tiers from one origin** (static `/api/v1/*` + compute `/v1/*`), self-hosted on the
**same shared server** as `../EUDR-due-diligence` and `../eu-ai-act-provenance`, reusing its shared
Caddy + APISIX + Redis. Tasks reference requirements. Recommended order: scaffold → schemas/data →
calculation engine → compute API → docs/tests → shared-infra wiring → deploy. **The calculator ships
first; registry submission is a documented, deferred follow-on, out of scope for v1** (R13).

- [ ] 1. Repository scaffolding
  - Root `package.json` (workspaces: `packages/*`, `type: module`), `.gitignore`
    (`node_modules`, `dist`, `/data`), MIT `LICENSE`, `LICENSE-DATA.md` (Commission-data
    redistribution + attribution), `DISCLAIMER.md` (not legal advice / not official registry /
    default-value estimate), `README.md`, `.dockerignore`.
  - _Requirements: R14_

- [ ] 2. Schemas (`schemas/`)
  - [ ] 2.1 `calculate-request.schema.json` — cnCode, originCountry (ISO2), tonnes>0, importYear?,
    carbonPrice?. `calculate-response.schema.json` — cbamGood, sector, inScope, embeddedEmissions,
    certificatesOwed, carbonPrice, cost, auditTrail, datasetVersions. _R1, R2_
  - [ ] 2.2 `calculation-record.schema.json` — input, resolved good, factors, certificatesOwed,
    cost, datasetVersions, calculatedAt, recordId. _R5_
  - [ ] 2.3 `declaration-request.schema.json` (bulk lines), `cn-code.schema.json`,
    `default-value.schema.json`, `country-factor.schema.json`. _R3, R6, R11_

- [ ] 3. Static reference datasets (`data/`) — version-pinned, source + effectiveDate on each
  - [ ] 3.1 `meta.json` — Reg (EU) 2023/956, definitive regime 2026-01-01, certificate
    purchase/surrender 2027-02, first declaration due 2027-09-30, registry opens 2026-Q4, 50-tonne
    de minimis, sectors, certificate definition, dataset versions, disclaimer, sources. _R6.6_
  - [ ] 3.2 `sectors.json` — the six in-scope sectors (iron-steel, aluminium, cement, fertilisers,
    hydrogen, electricity) + scope notes. _R6.1_
  - [ ] 3.3 `cn-codes.json` — CN code → CBAM good → sector mapping (inScope flag, source, version). _R6.2_
  - [ ] 3.4 `default-values.json` — published default embedded-emission values per good
    (tCO2e/t, source, version). _R6.3_
  - [ ] 3.5 `country-factors.json` — ISO2 → adjustment factor (source); documented default factor. _R6.4_
  - [ ] 3.6 `carbon-price.json` — cached EU ETS price (value, currency, asOf, source,
    freshnessWindowDays). _R4.1, R6.5_

- [ ] 4. Calculation engine (`packages/server/src/calc.mjs` + `packages/lib`)
  - [ ] 4.1 Pure `calculateLine(input, datasets, carbonPrice)`: cn→good→default→country
    factor→emissions→certificates(rounding)→cost; out-of-scope / below-de-minimis handling. _R1.1–R1.6_
  - [ ] 4.2 Share the exact engine in `packages/lib/src/calculate.mjs` so client + server produce
    identical results; ESM entry + types. _R7.1_
  - [ ] 4.3 `validateCalculationRecord(record, datasets)` — recompute + report mismatches. _R7.2_

- [ ] 5. Audit trail (`packages/server/src/audit.mjs`)
  - Build the ordered step list (cn-mapping → default-value → country-factor → emissions →
    certificates → cost), each entry citing source + datasetVersion; emit `datasetVersions` block;
    reproducible from the record alone. _R2.1–R2.4_

- [ ] 6. Carbon price (`packages/server/src/carbon-price.mjs`)
  - [ ] 6.1 Load cached ETS price with asOf + source; document the definitive-regime pricing basis
    in meta. _R4.1, R4.3_
  - [ ] 6.2 Client-supplied price override (what-if) tagged `source: "client-supplied"` in the
    audit trail. _R4.2_
  - [ ] 6.3 Scheduled refresh; freshness window → `stale` flag; failed refresh retains prior price. _R4.4, R16.4_

- [ ] 7. Datasets loader (`packages/server/src/datasets.mjs`)
  - Load + version-pin all reference datasets (cn-codes, default-values, country-factors, sectors);
    expose versions for `datasetVersions`; factors/thresholds are data, not code. _R11.1, R11.2, R11.4_

- [ ] 8. Persistence & metering (`packages/server/src/store.mjs`)
  - SQLite (better-sqlite3, WAL): `api_keys`, `usage(calculations, lines)`, `calculation_records`
    (inputs + metadata only); `makeKeyStore` (lookup / usageToday / record / createKey /
    getCalculation). _R5, R9.6_

- [ ] 9. Rate limiting (`packages/server/src/rate-limit.mjs`)
  - Port the reference projects' fixed-window limiter (memory + Redis backends); app prefix
    `cbam:rl:`; fail open on Redis outage. _R9.2, R9.5, R10.4_

- [ ] 10. Compute API (`packages/server/src/app.mjs` + `server.mjs`)
  - [ ] 10.1 `app.mjs` factory (injectable datasets/keys/backend/carbon-price) with public-mode auth
    (anonymous allowed, meter by key hash else IP), CORS, JSON body limits, `/healthz` (data load +
    carbon-price freshness). _R9.1, R16.1_
  - [ ] 10.2 `POST /v1/calculate` — single line → emissions + certificates + cost + audit trail;
    400 on bad ISO2 / non-positive tonnes; out-of-scope & below-de-minimis responses. _R1, R2_
  - [ ] 10.3 `POST /v1/declarations/calculate` — per-line + aggregate, max batch size, partial
    results, cost = 1/line, declaration-level de-minimis. _R3_
  - [ ] 10.4 `GET /v1/calculations/{recordId}` (key holders) + persist records; anonymous inline
    only. _R5_
  - [ ] 10.5 `GET /v1/usage`; per-key daily quota → 429 with `Retry-After` + `RateLimit-*`. _R9.5, R9.6_
  - [ ] 10.6 `server.mjs` — wire SQLite store, Redis backend (fallback memory), datasets, carbon
    price + scheduled refresh; graceful shutdown (drain, close Redis + SQLite). _R16.2_
  - [ ] 10.7 `seed-key.mjs` — issue an API key by tier. _R9.6_

- [ ] 11. Static build & data validation (`src/`)
  - [ ] 11.1 `validate-data.mjs` — fail build on schema-invalid reference data. _R11.3, R15.2_
  - [ ] 11.2 `build.mjs` — emit `dist/api/v1/` (index, meta, sectors, cn-codes[/{code}],
    default-values, country-factors, carbon-price, schemas), copy site + openapi + bundled lib;
    `BASE_PATH=/cbam` for correct public URLs. _R6, R8, R15.3_

- [ ] 12. Docs site + OpenAPI (`site/`, `openapi.yaml`)
  - [ ] 12.1 `openapi.yaml` (3.1) covering `/v1` compute + `/api/v1` static. _R8.3_
  - [ ] 12.2 `site/index.html` + `styles.css`: endpoint reference, `curl`/`fetch` examples, and a
    live calculator (CN code + origin + tonnes → emissions/certificates/cost + audit trail) using
    the bundled lib client-side. _R8.2_

- [ ] 13. Examples & tests (`examples/`, `test/`)
  - [ ] 13.1 `examples/calculate.request.json`, `declaration.request.json`,
    `calculation-record.example.json`. _R1, R3, R5_
  - [ ] 13.2 Unit: `calc.test.mjs` (mapping, rounding, country factor, de-minimis, out-of-scope),
    `audit.test.mjs` (trail completeness + reproducibility), `datasets.test.mjs`,
    `carbon-price.test.mjs` (stale flag, override), `data.test.mjs`, `rate-limit.test.mjs`. _R1–R5, R9, R11_
  - [ ] 13.3 Integration: boot app in-process (in-memory backend); exercise calculate,
    out-of-scope CN, below-de-minimis, bad ISO2 400, declaration bulk + partial results, 429. _R1, R3, R9_

- [ ] 14. Container & compose (`Dockerfile`, `docker-compose.yml`, `.env.example`)
  - [ ] 14.1 Multi-stage `Dockerfile`: build static dist + prod deps; runtime `node:20.18.1-slim`,
    non-root, read-only rootfs, `/tmp` tmpfs, `cap_drop: ALL`, `no-new-privileges`, healthcheck. _R15.4_
  - [ ] 14.2 `docker-compose.yml`: `cbam-api` (`BASE_PATH=/cbam`, `expose: 8792`, joins `cbam-net`
    + external `shared-net`, CPU/mem limits, `REQUIRE_KEY=false`, `RATE_LIMIT=false`,
    `REDIS_URL=...@shared-redis:6379/0`, `REDIS_PREFIX=cbam:rl:`, `CARBON_PRICE_REFRESH_CRON`,
    `TRUST_PROXY=1`), shared `caddy`, `backup` (daily SQLite `.backup`). App not published to host. _R10.1, R10.2, R10.6, R16.3_
  - [ ] 14.3 `.env.example` — `REDIS_PASSWORD` (must match `deploy/shared/.env`), `SITE_ADDRESS`,
    carbon-price refresh config. _R10.2_

- [ ] 15. Shared-server integration (reuse the SAME Redis + APISIX gateway) — see design §9
  - [ ] 15.1 Add `cbam-static` + `cbam-compute` (+ site catch-all + bare-`/cbam` redirect) route
    blocks to the shared `deploy/shared/apisix/apisix.yaml`, upstream `cbam-api:8792`, gateway
    limiter `redis_prefix: cbam:gw:` on DB 1, `allow_degradation: true`. _R10.3, R10.4_
  - [ ] 15.2 Add a `/cbam/*` handle to `deploy/Caddyfile` proxying `shared-apisix:9080`, forward
    real client IP; add `/cbam/` to the homepage listing. _R10.1_
  - [ ] 15.3 Verify **no collision** with EUDR or C2PA: distinct path prefix `/cbam`, Redis prefixes
    `cbam:rl:` / `cbam:gw:`, upstream node `cbam-api:8792`; shared stack unchanged. _R10.2, R10.5_
  - [ ] 15.4 `backup/backup.sh` — daily online `.backup` of the calculation SQLite with retention. _R16.3_

- [ ] 16. CI/CD (`.github/workflows/`)
  - [ ] 16.1 `ci.yml` — on push to `main`: validate data (fail on invalid) → unit+integration tests
    (Node 20) → build → build Docker image → Docker E2E smoke against the built image. _R15.1, R15.2_

- [ ] 17. Deploy on the shared server & verify (see design §9–§10, and reference `DEPLOY.md`)
  - Ensure shared stack is up (`docker network create shared-net`;
    `docker compose -f deploy/shared/docker-compose.yml up -d`), set this project's `.env`
    `REDIS_PASSWORD` to match, `docker compose up -d --build`, then
    `docker compose -f deploy/shared/docker-compose.yml restart apisix`.
  - Smoke: `curl http://SERVER_IP/cbam/api/v1/index.json`; `POST /cbam/v1/calculate` with
    `{cnCode, originCountry, tonnes}` returns emissions + certificates + cost + audit trail;
    confirm 429 headers, out-of-scope + below-de-minimis responses, bad-ISO2 400.
  - _Requirements: R9, R10, R15_

- [ ] 18. Publish public repository
  - Init git, commit, create the **public** repo, push `main`. MIT code + `LICENSE-DATA.md` +
    `DISCLAIMER.md` present; `meta.json` states not-legal-advice / not-official-registry. _R14_

> **Deferred (documented, not v1):** registry submission (`POST /v1/declarations/submit`) mapping
> the calculation + audit trail onto the Commission CBAM registry format when that API opens
> (Q4 2026); and computing **verified actual emissions** (requires an accredited verifier). v1 is
> the default-value calculator with a per-line audit trail. _R12, R13_
