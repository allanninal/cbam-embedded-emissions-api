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
      { good: "Steel semi", sector: "iron-steel", factor: 2.0, unit: "tCO2e/t" },
      { good: "Aluminium unwrought", sector: "aluminium", factor: 7.0, unit: "tCO2e/t" }
    ]
  },
  countryFactors: {
    version: "cf-test.1",
    source: "test",
    defaultFactor: 1.0,
    factors: [
      { iso2: "IN", factor: 1.0 },
      { iso2: "CN", factor: 1.2 }
    ]
  },
  meta: { deMinimisTonnes: 50, certificateRounding: "round-half-up" }
};

export const fixtureCarbonPrice = {
  value: 70,
  currency: "EUR",
  asOf: "2026-09-11",
  source: "EU ETS (test)",
  stale: false
};
