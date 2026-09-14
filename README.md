# CBAM Embedded Emissions API

Developer-first API for the **EU Carbon Border Adjustment Mechanism** (Regulation (EU) 2023/956,
"CBAM"). Take a **CN code, an origin country, and a tonnage**, and get back the **embedded
emissions**, the **CBAM certificates owed**, and **what they will cost** — with a **defensible
audit trail per declaration line**.

> ⚠️ **Not legal advice. Not the official EU CBAM registry.** Default-value estimates only; verified
> actual emissions require an accredited verifier. See [DISCLAIMER.md](./DISCLAIMER.md).

## Why this exists

The definitive CBAM regime began **1 January 2026**. Importers of **iron & steel, aluminium,
cement, fertilisers, hydrogen and electricity** above the **50-tonne** threshold need to compute
embedded emissions and certificate costs — and most are still doing it in spreadsheets. The field
is enterprise carbon-accounting suites sold top-down; **nobody ships a developer-first API** a
freight forwarder's or ERP vendor's engineer can call from inside a customs workflow.

**The product is the mapping, not the maths:** `CN code → CBAM good → default value → country
factor → certificate count`, with a per-line audit trail. All inputs are free and
Commission-published.

**Key dates:** definitive regime **1 Jan 2026**; declaration creation opens in the Commission's
registry **Q4 2026**; certificate purchase & surrender start **Feb 2027**; first annual declaration
(2026 imports) due **30 Sep 2027**.

## Architecture

Hosted on a **self-managed server** (GitHub is used only as the private code repo). A single Node
server serves **both tiers from one origin**, behind a shared Caddy reverse proxy — the **same
shared server, Caddy, APISIX gateway and Redis** as the sibling EUDR and C2PA APIs. See
[DEPLOY.md](./DEPLOY.md).

| Tier | Path | What |
|---|---|---|
| **Static** | `/api/v1/*` | Reference datasets (sectors, CN codes, default values, country factors, carbon price), schemas, docs, OpenAPI (no auth, not rate limited) |
| **Compute** | `/v1/*` | Per-line + bulk calculation, retained records (public/free, rate limited; optional API key) |

```
Internet → Caddy (TLS, body cap, real client IP)
              └── APISIX gateway (routing, Redis rate limiting, CORS)  ← shared, all projects
                    └── cbam-api container (expose 8792)
                          ├── /api/v1/*  static reference data + docs
                          └── /v1/*      compute (SQLite keys/usage/records, calc engine)
shared Redis ← APISIX limit-count (gateway, cbam:gw:) + app limiter (cbam:rl:, defense-in-depth)
```

Requests flow **Caddy → APISIX → the API**. APISIX is the shared Apache APISIX gateway
(standalone/YAML mode) that fronts this and every other API on the server. This project is mounted
under the **`/cbam`** path prefix and isolates its Redis keys with the **`cbam:rl:`** (app) and
**`cbam:gw:`** (gateway) prefixes, so it drops onto the same server next to EUDR (`/eudr`) and C2PA
(`/c2pa`) with zero collision. See [DEPLOY.md](./DEPLOY.md).

Data sources (all free, Commission-published): CBAM default embedded-emission values, CN-code
tables, country adjustment factors, and the public EU ETS carbon price.

## Endpoints

**Static (no auth):** `/api/v1/index.json`, `meta.json`, `sectors.json`, `cn-codes.json`,
`cn-codes/{code}.json`, `default-values.json`, `country-factors.json`, `carbon-price.json`,
`schemas/*.json`.

**Compute (public/free, rate limited):**
- `POST /v1/calculate` — single line → emissions + certificates + cost + audit trail
- `POST /v1/declarations/calculate` — bulk per-line + aggregate
- `GET /v1/calculations/{recordId}` — fetch a retained record (API-key holders)
- `GET /v1/usage` — key usage & quota

See [`openapi.yaml`](./openapi.yaml).

## Repository layout

```
data/            reference datasets (source of truth, version-pinned)
schemas/         JSON Schemas (calculate req/resp, calculation record, declaration, reference shapes)
src/             static build + data-validation gate
packages/lib     client calculation + record-validation library
packages/server  self-hosted compute API (Node/Express + SQLite + shared Redis)
site/            docs landing page + live calculator
test/            node:test suites
Dockerfile / docker-compose.yml / deploy/  container + shared Caddy proxy + APISIX route
.kiro/specs/cbam-embedded-emissions-api  requirements / design / tasks
```

## Develop

```bash
npm install
npm run validate   # validate datasets against schemas (build gate)
npm test           # run test suites
npm run build      # generate dist/ (static site + /api/v1 JSON)
node packages/server/src/server.mjs   # run the full API locally (REQUIRE_KEY=false for no auth)
```

## Access model & rate limiting

The compute endpoints are **free and public** — no API key required. To keep the service healthy
they are **rate limited per client** (by API key if one is sent, otherwise by client IP):

- Default: **60 requests/minute** and **5,000/day** per client (configurable).
- Bulk declarations cost **one unit per line**, so a 100-line declaration counts as 100.
- API-key holders get a separate, higher budget (5× minute, 10× day by default) and retained
  calculation history.
- Responses carry `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`; a throttled request
  returns **HTTP 429** with `Retry-After`.
- **Static reference endpoints (`/api/v1/*`) are not rate limited.**

Counters are stored in **shared Redis**, namespaced under `cbam:rl:` (app) and `cbam:gw:` (gateway)
so the same Redis serves EUDR, C2PA and this API without collisions. If Redis is unreachable the
limiter fails open. See [DEPLOY.md](./DEPLOY.md).

## Pricing anchors

Per-shipment calculation $0.05–0.50 · monthly tiers $299–2,999/mo for customs brokers, freight
forwarders and ERP vendors. The output drives certificate purchases worth real money, so the
calculation is cheap next to the decision.

## Scope

v1 is the **calculator** with a per-line audit trail — what importers need for 2026 imports.
**Registry submission** (mapping the calculation onto the Commission CBAM registry when that API
opens in Q4 2026) and **verified actual emissions** (which require an accredited verifier) are
documented, deferred follow-ons — out of scope for v1.

## Licensing

Code **MIT** ([LICENSE](./LICENSE)); reference data reproduced from free Commission publications
with attribution ([LICENSE-DATA.md](./LICENSE-DATA.md)).
