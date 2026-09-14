/**
 * Server-side calculation entrypoint.
 *
 * The maths is defined ONCE in @cbam/lib (packages/lib/src/calculate.mjs) so the
 * server and any client produce identical results and audit trails (R7.1). This
 * module re-exports that pure engine behind a stable server-local path and adds a
 * small declaration (bulk) helper used by the compute API.
 */
import { calculateLine, normalizeCnCode, roundCertificates } from "../../lib/src/calculate.mjs";

export { calculateLine, normalizeCnCode, roundCertificates };

/**
 * Calculate a whole declaration (array of lines) → per-line results + aggregate.
 * Per-line failures are captured as `{ ...line, error }` rather than aborting the
 * batch (R3.3). Cost is 1 unit per line for metering (handled by the caller).
 *
 * @param {Array} lines
 * @param {object} datasets
 * @param {object} carbonPrice
 * @param {object} [opts] { assessedAt, deMinimisTonnes }
 */
export function calculateDeclaration(lines, datasets, carbonPrice, opts = {}) {
  const deMinimis = opts.deMinimisTonnes ?? datasets.meta?.deMinimisTonnes ?? 50;
  const results = [];
  const agg = {
    totalEmissions: 0,
    totalCertificates: 0,
    totalCost: 0,
    currency: "EUR",
    linesInScope: 0,
    linesOutOfScope: 0
  };
  let declarationTonnes = 0;

  for (const line of lines) {
    try {
      const perLineCarbon = line.carbonPrice
        ? { ...carbonPrice, value: Number(line.carbonPrice), source: "client-supplied" }
        : carbonPrice;
      const r = calculateLine(line, datasets, perLineCarbon, opts);
      const out = { lineId: line.lineId ?? null, ...r };
      results.push(out);
      declarationTonnes += Number(line.tonnes) || 0;
      agg.totalEmissions += r.embeddedEmissions.value;
      agg.totalCertificates += r.certificatesOwed;
      agg.totalCost += r.cost.value;
      if (r.inScope) agg.linesInScope++; else agg.linesOutOfScope++;
    } catch (e) {
      results.push({ lineId: line.lineId ?? null, cnCode: line.cnCode, error: e.message });
      agg.linesOutOfScope++;
    }
  }

  agg.totalEmissions = round2(agg.totalEmissions);
  agg.totalCost = round2(agg.totalCost);
  agg.declarationTonnes = round2(declarationTonnes);
  // Whether the declaration as a whole crosses the de-minimis threshold (R3.2).
  agg.declarationCrossesDeMinimis = declarationTonnes >= deMinimis;

  return { lines: results, aggregate: agg };
}

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
