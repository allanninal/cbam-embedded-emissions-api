import { test } from "node:test";
import assert from "node:assert/strict";
import { calculateLine } from "../packages/lib/src/calculate.mjs";
import { makeCalculationRecord, checkAuditTrail, newRecordId } from "../packages/server/src/audit.mjs";
import { fixtureDatasets as ds, fixtureCarbonPrice as cp } from "./fixtures.mjs";

const opts = { assessedAt: "2026-09-14T00:00:00Z" };

test("audit trail has all six steps for an in-scope line, each with source + version", () => {
  const r = calculateLine({ cnCode: "72071110", originCountry: "IN", tonnes: 120 }, ds, cp, opts);
  assert.deepEqual(r.auditTrail.map((s) => s.step),
    ["cn-mapping", "default-value", "country-factor", "emissions", "certificates", "cost"]);
  const cnStep = r.auditTrail.find((s) => s.step === "cn-mapping");
  assert.equal(cnStep.datasetVersion, "cn-test.1");
  assert.equal(cnStep.source, "test");
  const dvStep = r.auditTrail.find((s) => s.step === "default-value");
  assert.equal(dvStep.datasetVersion, "dv-test.1");
});

test("checkAuditTrail reports complete for in-scope and out-of-scope", () => {
  const inScope = calculateLine({ cnCode: "72071110", originCountry: "IN", tonnes: 120 }, ds, cp, opts);
  assert.equal(checkAuditTrail(inScope).complete, true);
  const oos = calculateLine({ cnCode: "99999999", originCountry: "IN", tonnes: 120 }, ds, cp, opts);
  assert.equal(checkAuditTrail(oos).complete, true); // cn-mapping only
});

test("audit trail is reproducible: same input + versions ⇒ identical trail", () => {
  const a = calculateLine({ cnCode: "72071110", originCountry: "IN", tonnes: 120 }, ds, cp, opts);
  const b = calculateLine({ cnCode: "72071110", originCountry: "IN", tonnes: 120 }, ds, cp, opts);
  assert.deepEqual(a.auditTrail, b.auditTrail);
  assert.equal(a.cost.value, b.cost.value);
});

test("makeCalculationRecord captures inputs + dataset versions only", () => {
  const r = calculateLine({ cnCode: "72071110", originCountry: "IN", tonnes: 120 }, ds, cp, opts);
  const rec = makeCalculationRecord(r, { service: { name: "test", version: "1.0.0" } });
  assert.equal(rec.input.cnCode, "72071110");
  assert.equal(rec.certificatesOwed, r.certificatesOwed);
  assert.equal(rec.datasetVersions.cnMapping, "cn-test.1");
  assert.ok(rec.recordId);
  assert.equal(rec.currency, "EUR");
});

test("newRecordId is sortable by time", () => {
  const early = newRecordId(1000);
  const late = newRecordId(2_000_000_000_000);
  assert.ok(late > early);
});
