/**
 * CBAM per-line calculation — the single source of truth for the maths (R1, R2, R7).
 *
 * This is a PURE function of (input, datasets, carbonPrice). The server imports it
 * verbatim so a client can reproduce a server calculation byte-for-byte given the
 * same reference datasets and carbon price (R7.1). No I/O, no clock, no randomness
 * except the caller-supplied `assessedAt`.
 *
 * The product is the mapping, not the maths:
 *   CN code → CBAM good → default value → country factor → certificate count → cost
 * Every step is emitted into an ordered audit trail citing its source + dataset
 * version so the figure is reproducible from the record alone (R2).
 */

/** Normalise a CN code to digits only (callers may pass spaces/dots). */
export function normalizeCnCode(cnCode) {
  return String(cnCode == null ? "" : cnCode).replace(/[^0-9]/g, "");
}

/** Round to CBAM certificate count. 1 certificate = 1 tonne CO2e (R1.4). */
export function roundCertificates(emissions, rule = "round-half-up") {
  if (!(emissions > 0)) return 0;
  if (rule === "round-up" || rule === "ceil") return Math.ceil(emissions);
  if (rule === "round-down" || rule === "floor") return Math.floor(emissions);
  // round-half-up (default): 0.5 rounds away from zero.
  return Math.floor(emissions + 0.5);
}

/** Round money to 2 decimal places (EUR). */
function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * Resolve the default-value mark-up fraction for a sector + import year
 * (R1: default-value basis carries a mark-up that escalates by year). Returns a
 * fraction, e.g. 0.10 for +10%. Falls back to the table's default when the sector
 * or year is not explicitly listed.
 */
export function resolveMarkup(markups, sector, importYear) {
  if (!markups) return 0;
  const year = String(importYear || "");
  const sec = markups.sectors?.[sector];
  if (sec) {
    if (year && sec[year] != null) return Number(sec[year]);
    if (sec.beyond != null) return Number(sec.beyond);
  }
  const byYear = markups.defaultMarkupByYear || {};
  if (year && byYear[year] != null) return Number(byYear[year]);
  return Number(markups.defaultMarkupBeyond ?? 0);
}

/**
 * @typedef {object} Datasets
 * @property {{version:string, source:string, codes:Array}} cnCodes
 * @property {{version:string, source:string, values:Array}} defaultValues
 * @property {{version:string, source:string, defaultFactor:number, factors:Array}} countryFactors
 * @property {{deMinimisTonnes:number, certificateRounding?:string}} [meta]
 */

/**
 * Calculate a single CBAM line.
 *
 * @param {object} input  { cnCode, originCountry, tonnes, importYear?, carbonPrice? }
 * @param {Datasets} datasets
 * @param {object} carbonPrice  { value, currency, asOf, source, stale? }
 * @param {object} [opts]  { assessedAt?, deMinimisTonnes?, rounding? }
 * @returns {object} calculate response (matches calculate-response.schema.json)
 */
export function calculateLine(input, datasets, carbonPrice, opts = {}) {
  const { cnCodes, defaultValues, countryFactors, markups, meta = {} } = datasets;
  const assessedAt = opts.assessedAt || new Date().toISOString();
  const deMinimis = opts.deMinimisTonnes ?? meta.deMinimisTonnes ?? 50;
  const rounding = opts.rounding || meta.certificateRounding || "round-half-up";
  const importYear = input.importYear ?? opts.importYear ?? meta.defaultImportYear ?? 2026;

  const cnCode = normalizeCnCode(input.cnCode);
  const originCountry = String(input.originCountry || "").toUpperCase();
  const tonnes = Number(input.tonnes);

  const datasetVersions = {
    cnMapping: cnCodes.version,
    defaultValues: defaultValues.version,
    countryFactors: countryFactors.version,
    markups: markups?.version,
    carbonPrice: carbonPrice.asOf,
    stale: carbonPrice.stale === true
  };

  const base = {
    cnCode,
    originCountry,
    tonnes,
    basis: "default-values",
    assessedAt,
    datasetVersions
  };

  // 1) CN code → CBAM good (R1.2)
  const mapping = cnCodes.codes.find((c) => c.cnCode === cnCode);
  if (!mapping || mapping.inScope === false) {
    return {
      ...base,
      cbamGood: null,
      sector: null,
      inScope: false,
      reason: "out-of-scope",
      embeddedEmissions: { value: 0, unit: "tCO2e" },
      certificatesOwed: 0,
      carbonPrice: carbonPriceBlock(carbonPrice),
      cost: { value: 0, currency: "EUR" },
      auditTrail: [
        auditCn(cnCode, null, null, cnCodes, "not mapped to a CBAM Annex I good")
      ]
    };
  }

  // 2) Default emission factor for the good (R1.3)
  const dv = defaultValues.values.find((v) => v.good === mapping.good);
  // Prefer a country-specific default value where the binding methodology defines
  // one; otherwise use the good-level fallback (rest-of-world / top-10 average).
  let defaultFactor = null;
  let defaultValueBasis = "good-fallback";
  if (dv) {
    if (dv.byCountry && dv.byCountry[originCountry] != null) {
      defaultFactor = Number(dv.byCountry[originCountry]);
      defaultValueBasis = "country-specific";
    } else {
      defaultFactor = Number(dv.factor);
      defaultValueBasis = "good-fallback";
    }
  }

  // 3) Country factor (R1.3, R6.4)
  const cf = countryFactors.factors.find((f) => f.iso2 === originCountry);
  const countryFactor = cf ? Number(cf.factor) : Number(countryFactors.defaultFactor);
  const countryApplied = cf ? "listed" : "default";

  const auditTrail = [
    auditCn(cnCode, mapping.good, mapping.sector, cnCodes),
    {
      step: "default-value",
      good: mapping.good,
      factor: defaultFactor,
      basis: defaultValueBasis,
      country: defaultValueBasis === "country-specific" ? originCountry : null,
      unit: "tCO2e/t",
      source: defaultValues.source,
      datasetVersion: defaultValues.version
    },
    {
      step: "country-factor",
      country: originCountry,
      factor: countryFactor,
      applied: countryApplied,
      source: countryFactors.source,
      datasetVersion: countryFactors.version
    }
  ];

  if (defaultFactor == null) {
    // In scope but no default value available for this good — do not fabricate.
    return {
      ...base,
      cbamGood: mapping.good,
      sector: mapping.sector,
      inScope: false,
      reason: "out-of-scope",
      embeddedEmissions: { value: 0, unit: "tCO2e" },
      certificatesOwed: 0,
      carbonPrice: carbonPriceBlock(carbonPrice),
      cost: { value: 0, currency: "EUR" },
      auditTrail
    };
  }

  // Exempt origin (country factor 0 ⇒ Annex III country/territory outside CBAM
  // scope, e.g. EU-ETS participants). No certificates owed; report the indicative
  // (zero) emissions and a clear reason rather than a misleading in-scope zero.
  if (countryFactor === 0) {
    return {
      ...base,
      cbamGood: mapping.good,
      sector: mapping.sector,
      inScope: false,
      reason: "exempt-origin",
      embeddedEmissions: { value: 0, unit: "tCO2e" },
      certificatesOwed: 0,
      carbonPrice: carbonPriceBlock(carbonPrice),
      cost: { value: 0, currency: "EUR" },
      auditTrail
    };
  }

  // 4) Embedded emissions (R1.3)
  const emissionsRaw = tonnes * defaultFactor * countryFactor;
  const emissions = round2(emissionsRaw);
  auditTrail.push({
    step: "emissions",
    formula: "tonnes × defaultFactor × countryFactor",
    inputs: { tonnes, defaultFactor, countryFactor },
    value: emissions,
    unit: "tCO2e"
  });

  // 5) Default-value mark-up (R1): using default values (not verified actuals)
  // adds a sector- and year-dependent mark-up to the emissions figure before it
  // is converted to certificates. 10/20/30% (2026/27/28+) for iron-steel,
  // aluminium, cement; 1% for fertilisers; 0% for hydrogen/electricity.
  const markupPct = resolveMarkup(markups, mapping.sector, importYear);
  const markedUpEmissions = round2(emissions * (1 + markupPct));
  auditTrail.push({
    step: "markup",
    reason: "default-value basis (not verified actual emissions)",
    importYear,
    markupPct,
    formula: "emissions × (1 + markupPct)",
    value: markedUpEmissions,
    unit: "tCO2e",
    source: markups?.source,
    datasetVersion: markups?.version
  });

  // 6) Carbon price (R4.2) + de-minimis gate (R1.6)
  const price = carbonPriceBlock(carbonPrice);
  const belowDeMinimis = tonnes < deMinimis;

  // 7) Certificates owed (R1.4). Based on the marked-up emissions. Below
  // de-minimis ⇒ 0 certificates, indicative emissions kept.
  const certificatesOwed = belowDeMinimis ? 0 : roundCertificates(markedUpEmissions, rounding);
  auditTrail.push({
    step: "certificates",
    rounding,
    basis: "marked-up emissions",
    value: certificatesOwed,
    ...(belowDeMinimis ? { note: `below ${deMinimis}t de-minimis threshold; no certificates owed` } : {})
  });

  // cost = certificates × carbonPrice (R1.4)
  const cost = round2(certificatesOwed * price.value);
  auditTrail.push({
    step: "cost",
    formula: "certificatesOwed × carbonPrice",
    inputs: { certificatesOwed, carbonPrice: price.value },
    value: cost,
    currency: "EUR"
  });

  return {
    ...base,
    importYear,
    cbamGood: mapping.good,
    sector: mapping.sector,
    inScope: !belowDeMinimis,
    reason: belowDeMinimis ? "below-de-minimis" : null,
    embeddedEmissions: { value: emissions, unit: "tCO2e" },
    markup: { pct: markupPct, markedUpEmissions: { value: markedUpEmissions, unit: "tCO2e" } },
    certificatesOwed,
    carbonPrice: price,
    cost: { value: cost, currency: "EUR" },
    auditTrail
  };
}

function auditCn(cnCode, good, sector, cnCodes, note) {
  return {
    step: "cn-mapping",
    cnCode,
    resolvedGood: good,
    sector,
    ...(note ? { note } : {}),
    source: cnCodes.source,
    datasetVersion: cnCodes.version
  };
}

function carbonPriceBlock(carbonPrice) {
  return {
    value: Number(carbonPrice.value),
    currency: carbonPrice.currency || "EUR",
    asOf: carbonPrice.asOf,
    source: carbonPrice.source
  };
}
