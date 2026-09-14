// Shared fixtures for the unit + integration tests. Small, self-contained
// reference datasets so tests don't depend on the shipped data/ contents.

export const fixtureDatasets = {
  cnCodes: {
    version: "cn-test.1",
    source: "test",
    codes: [
      { cnCode: "72071110", good: "Steel semi", sector: "iron-steel", inScope: true },
      { cnCode: "76011000", good: "Aluminium unwrought", sector: "aluminium", inScope: true },
      { cnCode: "11111111", good: "Not covered", sector: "cement", inScope: false }
    ]
  },
  defaultValues: {
    version: "dv-test.1",
    source: "test",
    values: [
      { good: "Steel semi", sector: "iron-steel", factor: 2.0, unit: "tCO2e/t", byCountry: { CN: 2.5 } },
      { good: "Aluminium unwrought", sector: "aluminium", factor: 7.0, unit: "tCO2e/t" }
    ]
  },
  countryFactors: {
    version: "cf-test.1",
    source: "test",
    defaultFactor: 1.0,
    factors: [
      { iso2: "IN", factor: 1.0 },
      { iso2: "CN", factor: 1.2 },
      { iso2: "NO", factor: 0.0 }
    ]
  },
  meta: { deMinimisTonnes: 50, certificateRounding: "round-half-up" },
  markups: {
    version: "mk-test.1",
    source: "test",
    defaultMarkupByYear: { "2026": 0.10, "2027": 0.20, "2028": 0.30 },
    defaultMarkupBeyond: 0.30,
    sectors: {
      "iron-steel":  { "2026": 0.10, "2027": 0.20, "2028": 0.30, "beyond": 0.30 },
      "aluminium":   { "2026": 0.10, "2027": 0.20, "2028": 0.30, "beyond": 0.30 },
      "cement":      { "2026": 0.10, "2027": 0.20, "2028": 0.30, "beyond": 0.30 },
      "fertilisers": { "2026": 0.01, "2027": 0.01, "2028": 0.01, "beyond": 0.01 },
      "hydrogen":    { "2026": 0.00, "2027": 0.00, "2028": 0.00, "beyond": 0.00 },
      "electricity": { "2026": 0.00, "2027": 0.00, "2028": 0.00, "beyond": 0.00 }
    }
  }
};

export const fixtureCarbonPrice = {
  value: 70,
  currency: "EUR",
  asOf: "2026-09-11",
  source: "EU ETS (test)",
  stale: false
};
