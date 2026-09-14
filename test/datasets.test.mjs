import { test } from "node:test";
import assert from "node:assert/strict";
import { loadDatasets, loadCarbonPriceDoc, makeDatasets } from "../packages/server/src/datasets.mjs";

test("loadDatasets loads the shipped reference data with versions", () => {
  const ds = loadDatasets();
  assert.ok(ds.cnCodes.version);
  assert.ok(ds.defaultValues.version);
  assert.ok(ds.countryFactors.version);
  assert.ok(ds.markups.version);
  assert.equal(ds.meta.deMinimisTonnes, 50);
  assert.equal(ds.versions.cnMapping, ds.cnCodes.version);
  assert.equal(ds.versions.markups, ds.markups.version);
});

test("every in-scope shipped CN code resolves to a default value (except electricity)", () => {
  const ds = loadDatasets();
  const dvCodes = ds.defaultValues.values.map((v) => String(v.cnCode).replace(/[^0-9]/g, ""));
  const resolves = (cn) => dvCodes.some((k) => cn.startsWith(k) || k.startsWith(cn));
  for (const c of ds.cnCodes.codes) {
    if (!c.inScope || c.sector === "electricity") continue;
    const cn = String(c.cnCode).replace(/[^0-9]/g, "");
    assert.ok(resolves(cn), `no default value resolves for CN ${c.cnCode}`);
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
