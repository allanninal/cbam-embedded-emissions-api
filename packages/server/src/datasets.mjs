/**
 * Reference-dataset loader + version pinning (R11).
 *
 * Loads the version-pinned CBAM reference data (CN mapping, default values,
 * country factors, sectors, meta) from the `data/` directory and assembles the
 * object the pure engine (@cbam/lib) consumes. Emission factors, country factors,
 * and thresholds are DATA, not code (R11.4): a regulatory change is a data edit.
 *
 * `loadDatasets` reads from disk; `makeDatasets` builds from already-parsed JSON
 * (used by tests to inject fixtures without file I/O).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DATA_DIR = path.join(__dirname, "../../../data");

const readJson = (dir, name) => JSON.parse(readFileSync(path.join(dir, name), "utf8"));

/**
 * Assemble the datasets object from parsed JSON documents.
 * @param {object} docs { cnCodes, defaultValues, countryFactors, sectors, meta }
 */
export function makeDatasets(docs) {
  const { cnCodes, defaultValues, countryFactors, sectors, meta } = docs;
  return {
    cnCodes,
    defaultValues,
    countryFactors,
    sectors,
    meta,
    versions: {
      cnMapping: cnCodes.version,
      defaultValues: defaultValues.version,
      countryFactors: countryFactors.version,
      sectors: sectors?.version
    }
  };
}

/** Load all reference datasets from disk. */
export function loadDatasets(dataDir = process.env.DATA_DIR || DEFAULT_DATA_DIR) {
  return makeDatasets({
    cnCodes: readJson(dataDir, "cn-codes.json"),
    defaultValues: readJson(dataDir, "default-values.json"),
    countryFactors: readJson(dataDir, "country-factors.json"),
    sectors: readJson(dataDir, "sectors.json"),
    meta: readJson(dataDir, "meta.json")
  });
}

/** Load the carbon-price snapshot document from disk. */
export function loadCarbonPriceDoc(dataDir = process.env.DATA_DIR || DEFAULT_DATA_DIR) {
  return readJson(dataDir, "carbon-price.json");
}
