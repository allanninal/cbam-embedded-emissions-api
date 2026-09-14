import { test } from "node:test";
import assert from "node:assert/strict";
import { loadDatasets, loadCarbonPriceDoc, makeDatasets } from "../packages/server/src/datasets.mjs";

test("loadDatasets loads the shipped reference data with versions", () => {
  const ds = loadDatasets();
  assert.ok(ds.cnCodes.version);
  assert.ok(ds.defaultValues.version);
  assert.ok(ds.countryFactors.version);
  assert.equal(ds.meta.deMinimisTonnes, 50);
  assert.equal(ds.versions.cnMapping, ds.cnCodes.version);
});

test("every in-scope shipped CN code has a matching default value", () => {
  const ds = loadDatasets();
  const goods = new Set(ds.defaultValues.values.map((v) => v.good));
  for (const c of ds.cnCodes.codes) {
    if (c.inScope) assert.ok(goods.has(c.good), `missing default value for ${c.good}`);
  }
});

test("shipped meta.datasetVersions match the dataset files", () => {
  const ds = loadDatasets();
  assert.equal(ds.meta.datasetVersions.cnMapping, ds.cnCodes.version);
  assert.equal(ds.meta.datasetVersions.defaultValues, ds.defaultValues.version);
  assert.equal(ds.meta.datasetVersions.countryFactors, ds.countryFactors.version);
});

test("loadCarbonPriceDoc returns a positive EUR price", () => {
  const cp = loadCarbonPriceDoc();
  assert.ok(cp.value > 0);
  assert.equal(cp.currency, "EUR");
  assert.ok(cp.asOf);
});

test("makeDatasets builds from injected docs", () => {
  const ds = makeDatasets({
    cnCodes: { version: "x" }, defaultValues: { version: "y" },
    countryFactors: { version: "z" }, sectors: { version: "s" }, meta: {}
  });
  assert.equal(ds.versions.cnMapping, "x");
  assert.equal(ds.versions.defaultValues, "y");
});
