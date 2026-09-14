# Deployment (self-hosted, shared server)

The API is hosted on a shared server, not GitHub Pages. GitHub is used only as the code
repository. Both tiers run from **one origin** via a Node server behind a **shared Caddy reverse
proxy → shared APISIX gateway → shared Redis** — the same shared stack the sibling EUDR and C2PA
APIs use.

```
Internet :80/:443
   │
   ▼
Caddy (shared proxy, owns 80/443, routes by PATH PREFIX)
   ├── /cbam/*  → shared-apisix → cbam-api:8792   (this project)
   ├── /c2pa/*  → shared-apisix → c2pa-api:8790
   └── /eudr/*  → shared-apisix → eudr-api:8787
```

This project is mounted under the **`/cbam`** path prefix and isolates its Redis keys with the
**`cbam:rl:`** (app limiter) and **`cbam:gw:`** (gateway limiter) prefixes, so it drops onto the
same server next to EUDR and C2PA with **zero collision**.

| Concern | EUDR | C2PA | CBAM (this project) |
|---|---|---|---|
| Path prefix | `/eudr` | `/c2pa` | `/cbam` |
| Upstream node | `eudr-api:8787` | `c2pa-api:8790` | `cbam-api:8792` |
| App limiter prefix (Redis DB 0) | `eudr:rl:` | `c2pa:rl:` | `cbam:rl:` |
| Gateway limiter prefix (Redis DB 1) | `eudr:gw:` | `c2pa:gw:` | `cbam:gw:` |

## Shared services (Redis + API gateway)

Two shared services run in their own stack (`deploy/shared/`) so multiple projects on this server
reuse them:

- **Redis** — rate-limit counters (app + gateway).
- **Apache APISIX** (`shared-apisix`) — the shared API gateway (standalone/YAML mode, no etcd):
  routing, Redis-backed rate limiting, CORS.

First-time server setup (once — skip if the shared stack is already running for EUDR/C2PA):

```bash
docker network create shared-net
cp deploy/shared/.env.example deploy/shared/.env   # set REDIS_PASSWORD (openssl rand -hex 24)
docker compose -f deploy/shared/docker-compose.yml up -d   # starts redis + apisix
```

Gateway routes live in `deploy/shared/apisix/apisix.yaml`. For CBAM:
- `/cbam/api/*` → static reference data (free, **not** rate limited)
- `/cbam/v1/*`  → compute (rate limited via Redis, `cbam:gw:` prefix on Redis DB 1)

The Redis password is injected at container start (`entrypoint.sh` renders the route table from
the `__REDIS_PASSWORD__` placeholder) so the secret is never committed.

> If the shared stack is already running for EUDR/C2PA, you only need to ensure the CBAM route
> blocks are present in `deploy/shared/apisix/apisix.yaml` and reload:
> `docker compose -f deploy/shared/docker-compose.yml restart apisix`.

## First deploy

```bash
# on the server, in the repo directory:

# 0) shared services must exist first (see "Shared services" above).

# 1) this project's .env needs the SAME REDIS_PASSWORD as deploy/shared/.env
cp .env.example .env   # then set REDIS_PASSWORD to match the shared one

# 2) build + start
docker compose up -d --build

# 3) if you edited the shared route table, reload the gateway:
docker compose -f deploy/shared/docker-compose.yml restart apisix

# 4) (optional) issue an API key for the higher budget + retained history:
docker compose exec api node packages/server/src/seed-key.mjs broker

# verify (note the /cbam/ path prefix)
curl -s http://SERVER_IP/cbam/api/v1/index.json | head
curl -s -X POST http://SERVER_IP/cbam/v1/calculate \
  -H "content-type: application/json" \
  -d @examples/calculate.request.json
```

Expected smoke results:
- `GET /cbam/api/v1/index.json` returns the endpoint catalogue.
- `POST /cbam/v1/calculate` with `{cnCode, originCountry, tonnes}` returns `embeddedEmissions`,
  `certificatesOwed`, `cost`, and a 6-step `auditTrail`.
- A line below 50 t returns `inScope:false`, `reason:"below-de-minimis"`, `certificatesOwed:0`.
- An unmapped CN code returns `inScope:false`, `reason:"out-of-scope"`.
- Exceeding the per-client budget returns **429** with `RateLimit-*` + `Retry-After` headers.

## Adding a domain + automatic HTTPS

Point a DNS A record at the server (e.g. `apis -> SERVER_IP`; all projects share the host via
path prefixes, e.g. `https://apis.allanninal.dev/cbam/...`). Then set `SITE_ADDRESS=apis.allanninal.dev`
in `.env` and `docker compose up -d caddy` — Caddy provisions Let's Encrypt automatically. Do this
only AFTER DNS resolves, or the ACME challenge will fail.

## Hardening & operations

- **Non-root, minimal image:** multi-stage build; the compiler/dev deps stay in the builder
  stage; the runtime image runs as the non-root `node` user with production deps only.
- **Container hardening:** `cap_drop: ALL`, `no-new-privileges`, read-only root filesystem
  (writable data on the mounted volume + a `/tmp` tmpfs). Caddy keeps only `NET_BIND_SERVICE`.
- **Resource limits:** the api container is capped (0.5 CPU / 384 MB) so it can't starve
  co-located projects.
- **Graceful shutdown:** the API traps SIGTERM/SIGINT, drains in-flight requests, stops the
  carbon-price refresh loop, closes Redis and SQLite, then exits (10 s hard timeout).
- **Backups:** the `backup` service snapshots the SQLite keys/usage/records DB daily via the
  online `.backup` API to the `cbam-backups` volume, keeping the last 14 (gzip).
- **Carbon price:** the cached EU ETS price (`data/carbon-price.json`) is served with a computed
  freshness/`stale` flag. Set `CARBON_PRICE_REFRESH_MS` and wire a fetcher in `carbon-price.mjs`
  to refresh it on a schedule; a failed refresh retains the prior price and flags stale.
- **Reference data is version-pinned** (`data/*` carry `version` + `source` + `effectiveDate`);
  a dataset upgrade is a deliberate data edit surfaced in `meta.json` and every calculation's
  `datasetVersions`.

## Reference-data caveat

The shipped `data/default-values.json`, `data/cn-codes.json`, and `data/country-factors.json`
contain a representative subset with **illustrative default values** so the calculator is runnable
end-to-end. The **legally binding** definitive-period default values are those in **Commission
Implementing Regulation (EU) 2025/2621** (corrected by (EU) 2026/1740); the Commission also
publishes a companion **Excel** for information.

To load the real binding values, use the importer:

```bash
# export the Commission "Default values definitive period" sheet to CSV, then:
npm run import-default-values -- path/to/default-values.csv --version dv-2026.2
#   (accepts .xlsx too if the optional `xlsx` package is installed)
# then bump meta.datasetVersions.defaultValues to match, and:
npm run validate
```

The importer merges a good-level fallback (blank-country rows) with per-country overrides
(`byCountry`), matching the calculator's model. Also review:
- the **CN-code scope** (`data/cn-codes.json`) — covers all six sectors' Annex I headings
  (iron & steel chapter 72 + 7301–7311/7318/7326 + 2601 12; aluminium 7601/7603–7614/7616;
  cement 2507 00 80 + 2523; fertilisers 2808/2814/2834 21/3102/3105; hydrogen 2804 10;
  electricity 2716), with `exclusions` for ferro-alloys (7202), scrap (7204) and 3105 60. A
  production deployment should expand each in-scope heading to its full set of 8-digit CN
  subheadings;
- the **mark-up** table (`data/markups.json`) — 10/20/30% by year for iron-steel/aluminium/cement,
  1% fertilisers;
- **Annex III** exemptions in `data/country-factors.json`;
- the EU ETS reference price in `data/carbon-price.json`.

Bump each dataset `version` and the matching `meta.datasetVersions` entry when you update (the
build gate enforces they stay in sync).

## Updating

```bash
git pull
docker compose up -d --build
# if the shared route table changed:
docker compose -f deploy/shared/docker-compose.yml restart apisix
```
