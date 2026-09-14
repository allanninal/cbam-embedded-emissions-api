# Data & third-party inputs — licensing and attribution

The **code** in this repository is MIT licensed (see [LICENSE](./LICENSE)). This file covers the
**third-party reference data** the calculator relies on. Every input below is **free and
Commission-published** — the calculation needs **no paid data feed**.

## Reference data (European Commission — CBAM)

The following datasets are published by the European Commission. They are transcribed into the
`data/` directory, **version-pinned**, and each carries a `source` URL, `version`, and
`effectiveDate`. The dataset versions used are cited in every calculation's `datasetVersions`
block and audit trail.

- **Default embedded-emission values** — per-good default `tCO2e/t` values used when a verified
  actual value is not supplied. Published in the CBAM implementing acts and their annexes.
- **CN-code tables (CBAM Annex I goods)** — Combined Nomenclature codes in scope, mapped to the
  CBAM good and sector.
- **Country adjustment factors** — origin-country adjustments to the default value, where defined.

Source / documentation:
https://taxation-customs.ec.europa.eu/carbon-border-adjustment-mechanism_en

## Carbon price (EU ETS)

- **EU Emissions Trading System (EU ETS) carbon price** (EUR/tCO2e) — public market reference used
  to cost CBAM certificates. Cached in `data/carbon-price.json` with an `asOf` timestamp and
  source, and refreshed on a schedule. The exact value + `asOf` used appear in every audit trail.

## Regulatory references (informational, not data feeds)

- **Regulation (EU) 2023/956** establishing the Carbon Border Adjustment Mechanism, and its
  implementing acts. https://eur-lex.europa.eu/eli/reg/2023/956/oj

Regulatory text is quoted/paraphrased for context only and is **not legal advice**. See
[DISCLAIMER.md](./DISCLAIMER.md).

> **Redistribution:** Commission-published datasets are reproduced here for the calculator's
> operation with attribution. Do not treat cached copies as authoritative — the upstream
> Commission publications and the current EU ETS market price are. Always confirm against the
> current Official Journal texts and Commission tables.

## Attribution

When redistributing outputs of this service, retain attribution to the European Commission for the
CBAM default values, CN-code tables, and country adjustment factors, and to the EU ETS for the
carbon-price reference.
