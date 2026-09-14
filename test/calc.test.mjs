import { test } from "node:test";
import assert from "node:assert/strict";
import { calculateLine, roundCertificates, normalizeCnCode } from "../packages/lib/src/calculate.mjs";
import { calculateDeclaration } from "../packages/server/src/calc.mjs";
import { validateCalculationRecord } from "../packages/lib/src/validateRecord.mjs";
import { makeCalculationRecord } from "../packages/server/src/audit.mjs";
import { fixtureDatasets as ds, fixtureCarbonPrice as cp } from "./fixtures.mjs";

const opts = { assessedAt: "2026-09-14T00:00:00Z" };

test("normalizeCnCode strips spaces and dots", () => {
  assert.equal(normalizeCnCode("7207 11 10"), "72071110");
  assert.equal(normalizeCnCode("2523.29.00"), "25232900");
});

test("roundCertificates uses round-half-up", () => {
  assert.equal(roundCertificates(255.4), 255);
  assert.equal(roundCertificates(255.5), 256);
  assert.equal(roundCertificates(0), 0);
  assert.equal(roundCertificates(-5), 0);
});

test("in-scope line: emissions = tonnes × factor × countryFactor, markup + cost applied", () => {
  const r = calculateLine({ cnCode: "72071110", originCountry: "IN", tonnes: 120, importYear: 2026 }, ds, cp, opts);
  assert.equal(r.inScope, true);
  assert.equal(r.cbamGood, "Steel semi");
  assert.equal(r.sector, "iron-steel");
  assert.equal(r.embeddedEmissions.value, 240); // 120 * 2.0 * 1.0
  assert.equal(r.markup.pct, 0.10);             // iron-steel 2026 = +10%
  assert.equal(r.markup.markedUpEmissions.value, 264); // 240 * 1.10
  assert.equal(r.certificatesOwed, 264);
  assert.equal(r.cost.value, 18480);            // 264 * 70
  assert.equal(r.basis, "default-values");
});

test("markup escalates by import year (2027 = +20%, 2028 = +30%)", () => {
  const y27 = calculateLine({ cnCode: "72071110", originCountry: "IN", tonnes: 120, importYear: 2027 }, ds, cp, opts);
  assert.equal(y27.markup.pct, 0.20);
  assert.equal(y27.certificatesOwed, 288); // 240 * 1.20
  const y28 = calculateLine({ cnCode: "72071110", originCountry: "IN", tonnes: 120, importYear: 2028 }, ds, cp, opts);
  assert.equal(y28.markup.pct, 0.30);
  assert.equal(y28.certificatesOwed, 312); // 240 * 1.30
  const y30 = calculateLine({ cnCode: "72071110", originCountry: "IN", tonnes: 120, importYear: 2030 }, ds, cp, opts);
  assert.equal(y30.markup.pct, 0.30); // beyond 2028 stays 30%
});

test("fertilisers markup is capped at 1%", () => {
  // add a fertiliser mapping+value on the fly via a derived dataset
  const fds = {
    ...ds,
    cnCodes: { ...ds.cnCodes, codes: [...ds.cnCodes.codes, { cnCode: "31021010", good: "Urea", sector: "fertilisers", inScope: true }] },
    defaultValues: { ...ds.defaultValues, values: [...ds.defaultValues.values, { good: "Urea", sector: "fertilisers", factor: 1.0, unit: "tCO2e/t" }] }
  };
  const r = calculateLine({ cnCode: "31021010", originCountry: "IN", tonnes: 100, importYear: 2028 }, fds, cp, opts);
  assert.equal(r.markup.pct, 0.01);
  assert.equal(r.certificatesOwed, 101); // 100 * 1.01
});

test("country-specific default value overrides the good-level fallback", () => {
  // Steel semi has byCountry.CN = 2.5 (vs fallback 2.0); country factor for CN = 1.2.
  const r = calculateLine({ cnCode: "72071110", originCountry: "CN", tonnes: 100, importYear: 2026 }, ds, cp, opts);
  const dvStep = r.auditTrail.find((s) => s.step === "default-value");
  assert.equal(dvStep.basis, "country-specific");
  assert.equal(dvStep.factor, 2.5);
  assert.equal(r.embeddedEmissions.value, 300); // 100 * 2.5 * 1.2
});

test("good-level fallback used when no country-specific value exists", () => {
  const r = calculateLine({ cnCode: "72071110", originCountry: "IN", tonnes: 100, importYear: 2026 }, ds, cp, opts);
  const dvStep = r.auditTrail.find((s) => s.step === "default-value");
  assert.equal(dvStep.basis, "good-fallback");
  assert.equal(dvStep.factor, 2.0);
});

test("country factor is applied", () => {
  const r = calculateLine({ cnCode: "76011000", originCountry: "CN", tonnes: 100, importYear: 2026 }, ds, cp, opts);
  assert.equal(r.embeddedEmissions.value, 840); // 100 * 7.0 * 1.2
  assert.equal(r.certificatesOwed, 924); // 840 * 1.10 (aluminium 2026)
});

test("unlisted country uses default factor 1.0", () => {
  const r = calculateLine({ cnCode: "72071110", originCountry: "US", tonnes: 100 }, ds, cp, opts);
  assert.equal(r.embeddedEmissions.value, 200);
  const cf = r.auditTrail.find((s) => s.step === "country-factor");
  assert.equal(cf.applied, "default");
  assert.equal(cf.factor, 1.0);
});

test("below de-minimis: not in scope, 0 certificates, indicative emissions kept", () => {
  const r = calculateLine({ cnCode: "72071110", originCountry: "IN", tonnes: 10 }, ds, cp, opts);
  assert.equal(r.inScope, false);
  assert.equal(r.reason, "below-de-minimis");
  assert.equal(r.certificatesOwed, 0);
  assert.equal(r.cost.value, 0);
  assert.equal(r.embeddedEmissions.value, 20); // still shown
});

test("out-of-scope CN code: no fabricated emissions", () => {
  const r = calculateLine({ cnCode: "11111111", originCountry: "IN", tonnes: 100 }, ds, cp, opts);
  assert.equal(r.inScope, false);
  assert.equal(r.reason, "out-of-scope");
  assert.equal(r.cbamGood, null);
  assert.equal(r.certificatesOwed, 0);
});

test("exempt origin (Annex III, country factor 0): not in scope, 0 certificates", () => {
  const r = calculateLine({ cnCode: "72071110", originCountry: "NO", tonnes: 120 }, ds, cp, opts);
  assert.equal(r.inScope, false);
  assert.equal(r.reason, "exempt-origin");
  assert.equal(r.certificatesOwed, 0);
  assert.equal(r.cost.value, 0);
});

test("unknown CN code: out-of-scope", () => {
  const r = calculateLine({ cnCode: "99999999", originCountry: "IN", tonnes: 100 }, ds, cp, opts);
  assert.equal(r.inScope, false);
  assert.equal(r.reason, "out-of-scope");
});

test("client-supplied carbon price flows through to cost", () => {
  const priced = { ...cp, value: 100, source: "client-supplied" };
  const r = calculateLine({ cnCode: "72071110", originCountry: "IN", tonnes: 120, importYear: 2026 }, ds, priced, opts);
  assert.equal(r.carbonPrice.value, 100);
  assert.equal(r.carbonPrice.source, "client-supplied");
  assert.equal(r.cost.value, 26400); // 264 certs (240 * 1.10) * 100
});

test("stale carbon price surfaces in datasetVersions", () => {
  const r = calculateLine({ cnCode: "72071110", originCountry: "IN", tonnes: 120 }, ds, { ...cp, stale: true }, opts);
  assert.equal(r.datasetVersions.stale, true);
});

test("declaration aggregates per-line results", () => {
  const lines = [
    { lineId: "a", cnCode: "72071110", originCountry: "IN", tonnes: 120 },
    { lineId: "b", cnCode: "76011000", originCountry: "CN", tonnes: 100 }
  ];
  const { lines: out, aggregate } = calculateDeclaration(lines, ds, cp, { deMinimisTonnes: 50 });
  assert.equal(out.length, 2);
  assert.equal(aggregate.linesInScope, 2);
  assert.equal(aggregate.totalCertificates, 264 + 924); // both +10% (2026)
  assert.equal(aggregate.totalCost, 18480 + 64680);
  assert.equal(aggregate.declarationCrossesDeMinimis, true);
});

test("record round-trips through validateCalculationRecord", () => {
  const r = calculateLine({ cnCode: "72071110", originCountry: "IN", tonnes: 120 }, ds, cp, opts);
  const record = makeCalculationRecord(r, { service: { name: "test", version: "1.0.0" } });
  const { valid, mismatches } = validateCalculationRecord(record, ds, cp);
  assert.equal(valid, true, JSON.stringify(mismatches));
});

test("validateCalculationRecord catches a tampered cost", () => {
  const r = calculateLine({ cnCode: "72071110", originCountry: "IN", tonnes: 120 }, ds, cp, opts);
  const record = makeCalculationRecord(r, {});
  record.cost = 999999;
  const { valid, mismatches } = validateCalculationRecord(record, ds, cp);
  assert.equal(valid, false);
  assert.ok(mismatches.some((m) => m.field === "cost"));
});
