/**
 * Offline validation of a CBAM calculation record (R7.2).
 *
 * Recompute the line from the record's own inputs against the supplied reference
 * datasets + carbon price, then compare the recomputed certificates / cost /
 * emissions to what the record claims. Returns { valid, mismatches[] }.
 *
 * The caller must pass datasets whose versions match the record's
 * `datasetVersions` (a version mismatch is reported rather than silently
 * producing a different number).
 */
import { calculateLine } from "./calculate.mjs";

export function validateCalculationRecord(record, datasets, carbonPrice) {
  const mismatches = [];
  if (!record || typeof record !== "object") {
    return { valid: false, mismatches: [{ field: "record", reason: "not an object" }] };
  }

  // Version consistency: the datasets used to re-check must match the record.
  const rv = record.datasetVersions || {};
  const checkVersion = (field, have, want) => {
    if (want != null && have != null && String(have) !== String(want)) {
      mismatches.push({ field: `datasetVersions.${field}`, expected: want, actual: have });
    }
  };
  checkVersion("cnMapping", datasets?.cnCodes?.version, rv.cnMapping);
  checkVersion("defaultValues", datasets?.defaultValues?.version, rv.defaultValues);
  checkVersion("countryFactors", datasets?.countryFactors?.version, rv.countryFactors);

  const priceForRecalc = carbonPrice || {
    value: record.carbonPrice?.value,
    currency: record.currency || "EUR",
    asOf: record.carbonPrice?.asOf || rv.carbonPrice,
    source: "record"
  };

  const recomputed = calculateLine(record.input, datasets, priceForRecalc, {
    assessedAt: record.calculatedAt
  });

  const cmpNum = (field, expected, actual, tol = 0.01) => {
    if (expected == null && actual == null) return;
    if (Math.abs(Number(expected) - Number(actual)) > tol) {
      mismatches.push({ field, expected, actual });
    }
  };

  cmpNum("certificatesOwed", record.certificatesOwed, recomputed.certificatesOwed, 0);
  cmpNum("cost", record.cost, recomputed.cost.value);
  if (record.embeddedEmissions != null) {
    cmpNum("embeddedEmissions", record.embeddedEmissions, recomputed.embeddedEmissions.value);
  }
  if (record.cbamGood != null && record.cbamGood !== recomputed.cbamGood) {
    mismatches.push({ field: "cbamGood", expected: record.cbamGood, actual: recomputed.cbamGood });
  }

  return { valid: mismatches.length === 0, mismatches, recomputed };
}
