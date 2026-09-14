/**
 * Data validation gate (R11.3, R15.2). Fails the build (non-zero exit) if the
 * static reference data is malformed, drifts from its schemas, or is internally
 * inconsistent.
 *
 * Checks:
 *   - all JSON Schemas compile (draft 2020-12),
 *   - each reference dataset validates against its schema,
 *   - meta.json carries the required regulatory fields and correct key dates,
 *   - referential integrity: every CN-code good has a default value, sectors line
 *     up across files, and meta.datasetVersions match the dataset files.
 */
import Ajv from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (rel) => JSON.parse(readFileSync(path.join(root, rel), "utf8"));

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);

let failures = 0;
const fail = (msg) => { failures++; console.error(`  ✗ ${msg}`); };

console.log("Validating schemas and reference data...");

// 1) All schemas compile.
const schemasDir = path.join(root, "schemas");
const schemaFiles = readdirSync(schemasDir).filter((f) => f.endsWith(".json"));
const schemas = {};
for (const f of schemaFiles) {
  try {
    const s = readJson(`schemas/${f}`);
    schemas[f] = s;
    ajv.addSchema(s);
  } catch (e) { fail(`schema ${f} failed to parse: ${e.message}`); }
}

// 2) Parse reference data.
let meta, sectors, cnCodes, defaultValues, countryFactors, carbonPrice;
try { meta = readJson("data/meta.json"); } catch (e) { fail(`data/meta.json: ${e.message}`); }
try { sectors = readJson("data/sectors.json"); } catch (e) { fail(`data/sectors.json: ${e.message}`); }
try { cnCodes = readJson("data/cn-codes.json"); } catch (e) { fail(`data/cn-codes.json: ${e.message}`); }
try { defaultValues = readJson("data/default-values.json"); } catch (e) { fail(`data/default-values.json: ${e.message}`); }
try { countryFactors = readJson("data/country-factors.json"); } catch (e) { fail(`data/country-factors.json: ${e.message}`); }
try { carbonPrice = readJson("data/carbon-price.json"); } catch (e) { fail(`data/carbon-price.json: ${e.message}`); }

// 3) Validate datasets against their schemas.
const validateAgainst = (schemaFile, data, label) => {
  const schema = schemas[schemaFile];
  if (!schema || data == null) return;
  const validate = ajv.getSchema(schema.$id) || ajv.compile(schema);
  if (!validate(data)) {
    fail(`${label} fails ${schemaFile}: ${ajv.errorsText(validate.errors)}`);
  }
};
validateAgainst("cn-code.schema.json", cnCodes, "data/cn-codes.json");
validateAgainst("default-value.schema.json", defaultValues, "data/default-values.json");
validateAgainst("country-factor.schema.json", countryFactors, "data/country-factors.json");

// 4) meta.json required fields + key dates.
if (meta) {
  for (const k of ["regulation", "definitiveRegimeStart", "deMinimisTonnes", "sectors", "basis", "datasetVersions", "disclaimer", "sources"]) {
    if (meta[k] == null) fail(`meta.json missing required field: ${k}`);
  }
  if (meta.definitiveRegimeStart !== "2026-01-01") fail(`meta.json definitiveRegimeStart should be 2026-01-01, got ${meta.definitiveRegimeStart}`);
  if (meta.deMinimisTonnes !== 50) fail(`meta.json deMinimisTonnes should be 50, got ${meta.deMinimisTonnes}`);
  if (meta.basis !== "default-values") fail(`meta.json basis should be default-values, got ${meta.basis}`);
}

// 5) Referential integrity.
const SECTORS = ["iron-steel", "aluminium", "cement", "fertilisers", "hydrogen", "electricity"];
if (sectors) {
  const ids = sectors.sectors.map((s) => s.id).sort();
  if (JSON.stringify(ids) !== JSON.stringify([...SECTORS].sort())) {
    fail(`sectors.json ids ${JSON.stringify(ids)} do not match the six CBAM sectors`);
  }
}
if (cnCodes && defaultValues) {
  const goods = new Set(defaultValues.values.map((v) => v.good));
  for (const c of cnCodes.codes) {
    if (c.inScope && !goods.has(c.good)) {
      fail(`cn-codes.json: good "${c.good}" (${c.cnCode}) has no matching default value`);
    }
  }
}
if (meta && cnCodes && defaultValues && countryFactors) {
  const dv = meta.datasetVersions || {};
  if (dv.cnMapping !== cnCodes.version) fail(`meta.datasetVersions.cnMapping (${dv.cnMapping}) != cn-codes.json version (${cnCodes.version})`);
  if (dv.defaultValues !== defaultValues.version) fail(`meta.datasetVersions.defaultValues (${dv.defaultValues}) != default-values.json version (${defaultValues.version})`);
  if (dv.countryFactors !== countryFactors.version) fail(`meta.datasetVersions.countryFactors (${dv.countryFactors}) != country-factors.json version (${countryFactors.version})`);
}

// 6) carbon-price.json shape.
if (carbonPrice) {
  if (!(Number(carbonPrice.value) > 0)) fail("carbon-price.json: value must be a positive number");
  if (!carbonPrice.asOf) fail("carbon-price.json: asOf required");
  if (carbonPrice.currency !== "EUR") fail(`carbon-price.json: currency should be EUR, got ${carbonPrice.currency}`);
}

if (failures > 0) {
  console.error(`\nData validation FAILED with ${failures} error(s).`);
  process.exit(1);
}
console.log(`✓ All schemas compile and reference data is valid (${schemaFiles.length} schemas, ${cnCodes.codes.length} CN codes, ${defaultValues.values.length} default values).`);
