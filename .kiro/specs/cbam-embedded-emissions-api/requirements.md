# Requirements — CBAM Embedded Emissions API

## Overview

A **developer-first API for the EU Carbon Border Adjustment Mechanism (CBAM)** that lets any
importer, customs broker, freight forwarder, or ERP vendor turn a customs line into a defensible
carbon-cost figure. Given a **CN code, an origin country, and a tonnage**, the API returns the
**embedded emissions**, the **number of CBAM certificates owed**, and **what they will cost** —
with a **per-line audit trail** that documents every lookup and factor used to reach the number.

The API answers, for a single import line: *what CBAM good does this CN code map to, what default
embedded-emission value applies, what country adjustment (if any) applies, how many certificates
must be surrendered, and what is the euro cost at the current EU ETS carbon price?* — backed
entirely by free, Commission-published data.

### Product positioning
- **Buyers:** customs brokers, freight forwarders, and ERP/customs-software vendors whose
  engineers need to call CBAM maths from inside an existing customs or procurement workflow.
- **Gap:** the field is enterprise carbon-accounting suites sold top-down — CarbonChain, Sprih,
  carboneer, One Click LCA — plus SAP modules and big-four advisory practices. **No one ships a
  developer-first API** a forwarder's or ERP vendor's engineer can call from inside a customs
  workflow. Most importers still do this in spreadsheets.
- **The product is the mapping, not the maths:** `CN code → CBAM good → default value →
  country factor → certificate count`, with a defensible audit trail per declaration line. The
  arithmetic is trivial; the value is the correct, versioned, sourced mapping and the paper trail.
- **Data:** 100% free and Commission-published — default embedded-emission values, CN-code tables,
  country adjustment factors, and the public EU ETS carbon price. Verified *actual* values require
  an accredited verifier — that is the customer's obligation, not our data cost.

### Timeline / why now
- The **definitive CBAM regime began 1 January 2026**.
- Only **authorised CBAM declarants** may import in-scope goods above the **50-tonne** de minimis
  threshold; the first annual declaration covering 2026 imports is due **30 September 2027**.
- **Certificate purchase and surrender start February 2027**; declaration creation opens in the
  Commission's CBAM registry in **Q4 2026**.
- In-scope sectors: **iron & steel, aluminium, cement, fertilisers, hydrogen, and electricity**.
- **Main risk:** the Omnibus simplification raised de minimis to **50 tonnes**, exempting roughly
  90% of importers while retaining nearly all emissions — so the market is **fewer, larger
  importers**: higher contract values, longer sales cycles, incumbent ESG vendors to displace.

### Product staging
- **Ship now:** the **calculator** — the artifact importers need for their 2026 imports. It is a
  pure lookup + arithmetic engine over free reference data (the `$0` stack: no heavy compute).
- **Ship later (Q4 2026):** **registry submission** when the Commission's registry API opens. The
  calculator alone is what importers need first; submission is a documented, deferred follow-on
  (out of scope for v1, see R13).

> **Disclaimer:** This service provides an **estimation and audit-trail tool** for CBAM embedded
> emissions and certificate costs using **published Commission default values**. It is **not legal
> advice**, is **not** the official EU CBAM registry, and a calculated figure is **not** a
> substitute for verified actual emissions from an accredited verifier where those are required.
> Final responsibility for the CBAM declaration rests with the authorised declarant. See
> `DISCLAIMER.md`.

## Goals
- **Deterministic, auditable per-line calculation** from free Commission data:
  CN code + origin + tonnage → embedded emissions + certificates owed + euro cost.
- A **defensible audit trail per declaration line**: every response records the exact CN-code
  mapping, default value, country factor, carbon price, and dataset versions used.
- **Bulk / per-declaration** calculation so an ERP or broker can price a whole customs entry in
  one call, with an aggregate + per-line breakdown.
- **Public and free** to use (like the reference EUDR and C2PA projects): anonymous access
  allowed, rate limited per client; optional API keys unlock a higher budget and retained
  calculation history.
- Pure **lookup + arithmetic** — the `$0` stack — so edge/self-hosted queries are fast and cheap.

## Non-Goals
- **Submitting declarations** to the EU CBAM registry on the user's behalf (v1 produces the
  calculation + audit trail; the declarant submits). Registry submission is a documented,
  deferred follow-on (R13).
- **Computing verified actual emissions.** Actual values require an accredited verifier; we
  provide the **default-value** calculation and clearly flag where verified actuals are needed.
- Determining a client's **authorised-declarant** status or legal eligibility to import.
- Legal / compliance sign-off, or tax/customs advice.

## Deployment constraint (explicit)
This API runs **self-hosted on the shared server**, exactly like the reference projects at
`../EUDR-due-diligence` and `../eu-ai-act-provenance`. It reuses that server's **shared services**:
one Caddy edge, one **Apache APISIX** gateway, and one **Redis** — it does **not** provision its
own. The project is mounted under a **path prefix** (`/cbam`) and isolates itself with
**project-specific Redis prefixes** (`cbam:rl:` for the app limiter, `cbam:gw:` for the gateway
limiter). See the design doc §Deployment and R9/R10.

The calculation is pure lookup + arithmetic, so the reference projects' **Node/Express + SQLite +
shared-Redis** pattern is preserved with no additional heavy runtime.

---

## Requirements

### R1 — Per-line CBAM calculation (core)
**User story:** As a customs broker, I want to submit a CN code, an origin country, and a tonnage
and get the embedded emissions, certificates owed, and euro cost, so I can price a customs line.

**EARS:**
1. WHEN a client POSTs `{ cnCode, originCountry, tonnes, importYear? }` to
   `POST /v1/calculate` THEN the system SHALL return `{ cbamGood, sector, embeddedEmissions,
   certificatesOwed, carbonPrice, cost, inScope, auditTrail, assessedAt, datasetVersions }`.
2. The system SHALL resolve `cnCode` → **CBAM good** (sector + product) via the versioned CN-code
   mapping table; an unmapped/out-of-scope CN code SHALL return `inScope = false` with a `reason`
   and SHALL NOT fabricate an emissions figure.
3. `embeddedEmissions` SHALL be `tonnes × defaultEmissionFactor` (tCO2e), using the published
   **default embedded-emission value** for the resolved good, adjusted by the applicable
   **country factor** for `originCountry` when one is defined (default factor otherwise).
4. `certificatesOwed` SHALL be the embedded emissions expressed in **CBAM certificates** (1
   certificate = 1 tonne CO2e), rounded per the documented rounding rule; `cost` SHALL be
   `certificatesOwed × carbonPrice` in EUR using the current **EU ETS** price.
5. `originCountry` SHALL be a valid ISO 3166-1 alpha-2 code; `tonnes` SHALL be a positive number;
   invalid input SHALL return **400** with a field-level error.
6. IF `tonnes` is below the **50-tonne de minimis threshold** for the importer/consignment THEN
   the response SHALL set `inScope = false` (`reason: below-de-minimis`) while still returning the
   indicative emissions figure, so the caller can see why no certificates are owed.

### R2 — Per-line audit trail (the sellable artifact)
**User story:** As an authorised declarant, I want a defensible record of exactly how each line's
number was derived, so I can support it during the annual declaration and any review.

**EARS:**
1. WHEN a calculation completes THEN the response SHALL include an `auditTrail` recording each
   step: the CN-code → CBAM-good mapping (with mapping table version), the default emission factor
   used (with value + source + version), the country factor applied (value + source, or "default"),
   the carbon price used (value + `asOf` timestamp + source), the rounding rule, and the resulting
   `embeddedEmissions` / `certificatesOwed` / `cost`.
2. Each audit-trail entry SHALL cite its **source** (Commission publication / dataset) and the
   **dataset version** used, so the figure is reproducible from the record alone.
3. The audit trail SHALL be **stable and reproducible**: recalculating the same input against the
   same dataset versions SHALL yield an identical result and trail.
4. The response SHALL carry a `datasetVersions` block naming every dataset version used
   (CN mapping, default values, country factors, carbon price snapshot).

### R3 — Bulk / per-declaration calculation
**User story:** As an ERP integrator, I want to price all the lines of a customs entry in one call.

**EARS:**
1. WHEN a client POSTs an array of lines to `POST /v1/declarations/calculate` THEN the system SHALL
   return a per-line result plus an **aggregate** `{ totalEmissions, totalCertificates, totalCost,
   currency, linesInScope, linesOutOfScope }`.
2. The de-minimis threshold SHALL be evaluated at the documented level (per consignment/declarant
   as configured), and the aggregate SHALL state whether the declaration as a whole crosses the
   50-tonne threshold.
3. The endpoint SHALL enforce a documented **max batch size** and return **partial results** with
   per-line errors rather than failing the whole batch.
4. Batch cost SHALL be **one unit per line**, so a 100-line declaration counts as 100 (mirrors the
   reference projects' per-item metering).

### R4 — Carbon price handling
**User story:** As an importer, I want the certificate cost based on the correct EU ETS carbon
price, with the price and its timestamp on the record.

**EARS:**
1. The system SHALL maintain a cached **EU ETS carbon price** (EUR/tCO2e) with a recorded `asOf`
   timestamp and source, refreshed on a documented schedule.
2. WHEN a client supplies an explicit `carbonPrice` (for "what-if" pricing or a fixed declaration
   period) THEN the system SHALL use it and record `carbonPrice.source = "client-supplied"` in the
   audit trail; otherwise it SHALL use the cached published price.
3. The CBAM definitive-regime pricing basis SHALL be documented (e.g. the relevant weekly/average
   ETS reference), and the exact price value + `asOf` SHALL always appear in the audit trail (R2).
4. IF the carbon-price source is stale beyond a documented freshness window THEN the response SHALL
   set a `stale` flag in `datasetVersions` — never silently serve an outdated price without notice.

### R5 — Calculation record retrieval (retained history)
**User story:** As a platform, I want to retain and re-fetch prior calculations for reconciliation.

**EARS:**
1. WHEN a calculation completes for an API-key holder THEN the system SHALL persist a **calculation
   record** (`recordId`, inputs, resolved good, factors, `certificatesOwed`, `cost`, dataset
   versions, `calculatedAt`) — inputs and derived metadata only.
2. `GET /v1/calculations/{recordId}` SHALL return a previously issued record (for API-key holders;
   retention window documented per tier). Anonymous callers receive the full record inline in the
   response but no server-side retention.
3. The stored record SHALL be sufficient to **reproduce** the figure and reconstruct the audit
   trail given the same dataset versions (R2.3).

### R6 — Reference data lookups (public, no auth)
**User story:** As a developer, I want the CN-code → CBAM-good mapping, default values, country
factors, and sector scope as static JSON I can browse and cache.

**EARS:**
1. `GET /api/v1/sectors.json` SHALL list the six in-scope sectors (iron & steel, aluminium,
   cement, fertilisers, hydrogen, electricity) with their scope notes.
2. `GET /api/v1/cn-codes.json` SHALL return the CN-code → CBAM-good mapping (code, good, sector);
   `GET /api/v1/cn-codes/{code}.json` SHALL return a single mapping or 404.
3. `GET /api/v1/default-values.json` SHALL return the published default embedded-emission values
   per good (value, unit tCO2e/t, source, version).
4. `GET /api/v1/country-factors.json` SHALL return country adjustment factors (ISO2 → factor,
   source); unlisted countries SHALL default to the documented default factor.
5. `GET /api/v1/carbon-price.json` SHALL return the current cached EU ETS price with `asOf` +
   source.
6. `GET /api/v1/meta.json` SHALL return the regulation id, key dates (definitive regime
   1 Jan 2026; certificate purchase/surrender Feb 2027; first declaration due 30 Sep 2027;
   registry opens Q4 2026), the 50-tonne de-minimis threshold, dataset versions, and authoritative
   source links.
7. Static reference endpoints SHALL be **public and NOT rate limited** — matching the reference
   projects.

### R7 — Client library
**User story:** As an integrator, I want to reproduce and validate a calculation locally.

**EARS:**
1. `calculateLine(input, datasets)` SHALL reproduce the server's per-line calculation given the
   reference datasets, returning the same `{ embeddedEmissions, certificatesOwed, cost, auditTrail }`.
2. `validateCalculationRecord(record, datasets)` SHALL recompute from the recorded inputs +
   dataset versions and return `{ valid, mismatches[] }`.
3. The library SHALL run in Node and the browser and be bundled into the docs page for a live
   calculator demo.

### R8 — Discovery & docs (public, no auth)
**EARS:**
1. `GET /api/v1/index.json` SHALL catalogue all endpoints (static + compute base URL).
2. The docs site SHALL document every endpoint with `curl`/`fetch` examples and a **live
   calculator** (enter CN code + country + tonnes → emissions/certificates/cost) using the bundled
   library client-side.
3. The repo SHALL include an **OpenAPI 3.1** description covering compute and static endpoints.

### R9 — Access model, rate limiting & metering (public/free)
**User story:** As the business, I want the API free and public but abuse-protected, with optional
keys enabling a higher budget and retained calculation history for paid tiers.

**EARS:**
1. Compute endpoints (R1, R3, R5) SHALL be usable **anonymously** (no API key required), matching
   the reference projects' public model (`REQUIRE_KEY=false`).
2. Requests SHALL be **rate limited per client** — by API key if one is sent, otherwise by real
   client IP — enforced at the **shared APISIX gateway** (Redis `limit-count`), with the app-side
   limiter available as defense-in-depth.
3. Default anonymous limits SHALL be **60 requests/minute** and **5,000/day** per client
   (configurable); API-key holders SHALL get a higher budget (5× minute, 10× day by default).
4. Calculation cost SHALL be **1 unit per line**; batch cost SHALL be **1 unit per line**.
5. WHEN a client exceeds a limit THEN the system SHALL return **429** with `Retry-After` and a
   documented JSON error body, and responses SHALL carry `RateLimit-Limit` / `-Remaining` /
   `-Reset` headers.
6. The system SHALL record per-key usage counts sufficient to support pricing tiers.
7. Pricing anchors (documented, not hard-coded): **$0.05–0.50 per shipment calculation**; monthly
   tiers **$299–2,999/mo** for customs brokers, freight forwarders, and ERP vendors.

### R10 — Shared-server integration (Redis + API gateway)
**User story:** As the operator, I want this API to run on the **same server** and reuse the
**same Redis and API gateway** as the EUDR and C2PA projects, without collisions.

**EARS:**
1. The service SHALL run as a container published **only** to the internal network / `127.0.0.1`
   (via `expose`), reachable solely through the shared Caddy → APISIX path.
2. The service SHALL join the external **`shared-net`** Docker network and connect to the shared
   **`shared-redis`** using a **project-specific key prefix** (`cbam:rl:` app limiter) and the
   shared Redis DBs (app data on DB 0, gateway counters on DB 1) so keys never collide with EUDR or
   C2PA.
3. A route block SHALL be added to the shared **APISIX** table (`deploy/shared/apisix/apisix.yaml`)
   under prefix **`/cbam`** with `proxy-rewrite` stripping the prefix, the `real-ip` plugin, a
   `limit-count` policy `redis` using `redis_prefix: "cbam:gw:"` on Redis DB 1, and CORS.
4. IF Redis is unreachable THEN both the gateway (`allow_degradation`) and the app limiter SHALL
   **fail open** rather than reject traffic.
5. Adding this project SHALL NOT require removing or reconfiguring EUDR's or C2PA's routes,
   prefixes, or data; the shared stack (`deploy/shared/`) SHALL remain a single deployment shared
   by all projects.
6. Resource limits (CPU/memory) SHALL be set on the container so it cannot starve co-located
   projects.

### R11 — Data integrity & versioning
**User story:** As an auditor, I want the reference data pinned and versioned so a calculation is
reproducible months later.

**EARS:**
1. All reference datasets (CN mapping, default values, country factors, sector scope, carbon-price
   snapshot) SHALL be **version-pinned**, each carrying a `version`, `source` URL, and
   `effectiveDate`.
2. Dataset upgrades SHALL be a **deliberate, recorded change** surfaced in `meta.json` and in every
   affected calculation's `datasetVersions`.
3. The build SHALL **fail** on any schema-invalid reference data (build-time validation gate).
4. Emission factors, country factors, and thresholds SHALL be **data, not hard-coded logic**, so a
   regulatory change is a data edit rather than a code change.

### R12 — Honest scope & estimation limits
**User story:** As the business, I want to be clear that this is a default-value estimator with an
audit trail, not a verified-emissions or legal-submission service.

**EARS:**
1. Every calculation SHALL indicate the **basis** used (`basis: "default-values"`) and SHALL state
   in the record that verified actual emissions require an **accredited verifier**.
2. The API SHALL NOT claim to determine authorised-declarant status or to submit declarations in
   v1.
3. Documentation and `DISCLAIMER.md` SHALL state the service is **not legal advice**, is **not**
   the official EU CBAM registry, and that a calculated figure is an estimate for the declarant's
   own use.

### R13 — Deferred: registry submission (documented, not v1)
**User story:** As the product owner, I want the registry-submission path documented as a planned
follow-on without building it in v1.

**EARS:**
1. The design SHALL document how a future `POST /v1/declarations/submit` maps the calculation +
   audit trail onto the Commission CBAM registry submission format when that API opens (Q4 2026).
2. v1 SHALL ship the **calculator only**; submission SHALL be clearly marked **out of scope for
   v1** in the requirements, design, and tasks.

### R14 — Openness, licensing & disclaimer
**EARS:**
1. The repository SHALL be public: **MIT** for code; a `LICENSE-DATA.md` covering the redistribution
   of Commission-published data with attribution.
2. `DISCLAIMER.md` and `meta.json` SHALL state the service is **not legal advice**, is **not** the
   official EU CBAM registry, and that default-value figures are estimates.
3. All external inputs (default values, CN tables, country factors, EU ETS price) SHALL be
   attributed with their source URLs and versions.

### R15 — CI/CD & hosting
**EARS:**
1. WHEN changes are pushed to `main` THEN CI SHALL validate reference data against schemas, run
   tests (unit + integration), and build the static tier + container image.
2. The data/build step SHALL **FAIL** on any schema-invalid reference data.
3. Static URLs SHALL be versioned under `/api/v1/`; compute under `/v1/`, served from **one origin**
   by the Node service (mirroring the reference projects).
4. The container image SHALL be reproducible and hardened (non-root, read-only root filesystem,
   dropped capabilities, pinned base images), matching the reference projects.

### R16 — Observability & operations
**EARS:**
1. `GET /healthz` SHALL report service liveness (including reference-data load + carbon-price
   freshness).
2. The service SHALL trap SIGTERM/SIGINT, drain in-flight requests, close Redis and SQLite, and
   exit within a bounded timeout (graceful shutdown), matching the reference projects.
3. Calculation records (SQLite) SHALL be backed up on a schedule with retention, matching the
   reference projects' backup service.
4. A scheduled refresh SHALL update the cached EU ETS carbon price and record its `asOf` + source
   (R4.1); a failed refresh SHALL retain the prior price and set the `stale` flag (R4.4).
