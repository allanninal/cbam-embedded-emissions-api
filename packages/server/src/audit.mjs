/**
 * Audit trail + calculation record helpers (R2, R5).
 *
 * The per-line audit trail is built inside the pure engine (@cbam/lib) so client
 * and server produce an identical, reproducible trail (R2.3). This module:
 *   - builds the persisted calculation-record shape from a calculation result,
 *   - assigns a sortable record id (ULID-like: time-ordered + random),
 *   - asserts trail completeness (every expected step present) for tests/health.
 */
import crypto from "node:crypto";
import { AUDIT_STEPS } from "../../lib/src/index.mjs";

/** A monotonic, sortable id: 10-char base32 time prefix + 16 random hex chars. */
export function newRecordId(now = Date.now()) {
  const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let t = now;
  let time = "";
  for (let i = 0; i < 10; i++) { time = B32[t % 32] + time; t = Math.floor(t / 32); }
  return time + crypto.randomBytes(8).toString("hex").toUpperCase();
}

/**
 * Build the retained calculation record from a calculate() result (R5.1).
 * Inputs + derived metadata only — reproducible from the record + dataset
 * versions (R2.3, R5.3). No PII, no bytes.
 */
export function makeCalculationRecord(result, { service, recordId } = {}) {
  return {
    recordId: recordId || newRecordId(),
    input: {
      cnCode: result.cnCode,
      originCountry: result.originCountry,
      tonnes: result.tonnes,
      importYear: result.importYear ?? null
    },
    cbamGood: result.cbamGood ?? null,
    sector: result.sector ?? null,
    inScope: result.inScope,
    embeddedEmissions: result.embeddedEmissions.value,
    certificatesOwed: result.certificatesOwed,
    carbonPrice: { value: result.carbonPrice.value, asOf: result.carbonPrice.asOf },
    cost: result.cost.value,
    currency: "EUR",
    datasetVersions: {
      cnMapping: result.datasetVersions.cnMapping,
      defaultValues: result.datasetVersions.defaultValues,
      countryFactors: result.datasetVersions.countryFactors,
      markups: result.datasetVersions.markups,
      carbonPrice: result.datasetVersions.carbonPrice
    },
    calculatedAt: result.assessedAt,
    service: service || { name: "cbam-embedded-emissions-api", version: "1.0.0" }
  };
}

/**
 * Assert the audit trail is complete for an in-scope calculation: all six steps
 * present and each citing a source/version where applicable (R2.1, R2.2).
 * Returns { complete, missing[] }.
 */
export function checkAuditTrail(result) {
  const steps = new Set((result.auditTrail || []).map((e) => e.step));
  // Out-of-scope trails legitimately stop after cn-mapping.
  const expected = result.inScope
    ? AUDIT_STEPS
    : ["cn-mapping"];
  const missing = expected.filter((s) => !steps.has(s));
  return { complete: missing.length === 0, missing };
}
