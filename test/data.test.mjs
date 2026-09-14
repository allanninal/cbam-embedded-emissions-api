import { test } from "node:test";
import assert from "node:assert/strict";
import Ajv from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (rel) => JSON.parse(readFileSync(path.join(root, rel), "utf8"));

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const compile = (schemaRel) => ajv.compile(readJson(schemaRel));

test("cn-codes.json validates against its schema", () => {
  const validate = compile("schemas/cn-code.schema.json");
  assert.ok(validate(readJson("data/cn-codes.json")), ajv.errorsText(validate.errors));
});

test("default-values.json validates against its schema", () => {
  const validate = compile("schemas/default-value.schema.json");
  assert.ok(validate(readJson("data/default-values.json")), ajv.errorsText(validate.errors));
});

test("country-factors.json validates against its schema", () => {
  const validate = compile("schemas/country-factor.schema.json");
  assert.ok(validate(readJson("data/country-factors.json")), ajv.errorsText(validate.errors));
});

test("meta.json has the required regulatory fields and key dates", () => {
  const meta = readJson("data/meta.json");
  assert.equal(meta.definitiveRegimeStart, "2026-01-01");
  assert.equal(meta.deMinimisTonnes, 50);
  assert.equal(meta.basis, "default-values");
  assert.equal(meta.sectors.length, 6);
});

test("example calculation record validates against its schema", () => {
  const validate = compile("schemas/calculation-record.schema.json");
  assert.ok(validate(readJson("examples/calculation-record.example.json")), ajv.errorsText(validate.errors));
});
