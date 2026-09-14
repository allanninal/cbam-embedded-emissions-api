/**
 * @cbam/lib — client library.
 *
 * - calculateLine: the exact pure calculation the server runs, so a client can
 *   reproduce a per-line CBAM figure + audit trail offline.
 * - validateCalculationRecord: recompute a retained record and report mismatches.
 * - SECTORS / AUDIT_STEPS / UNSCOPED_REASONS: the response vocabulary.
 */
export { calculateLine, normalizeCnCode, roundCertificates } from "./calculate.mjs";
export { validateCalculationRecord } from "./validateRecord.mjs";

export const SECTORS = ["iron-steel", "aluminium", "cement", "fertilisers", "hydrogen", "electricity"];
export const AUDIT_STEPS = ["cn-mapping", "default-value", "country-factor", "emissions", "certificates", "cost"];
export const UNSCOPED_REASONS = ["out-of-scope", "below-de-minimis"];
