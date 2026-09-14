import { test } from "node:test";
import assert from "node:assert/strict";
import { createCarbonPrice } from "../packages/server/src/carbon-price.mjs";

const base = { value: 72.14, currency: "EUR", asOf: "2026-09-11", source: "EU ETS", freshnessWindowDays: 14 };
const NOW = Date.parse("2026-09-14T00:00:00Z");

test("snapshot is fresh within the freshness window", () => {
  const cp = createCarbonPrice(base);
  const s = cp.snapshot(NOW);
  assert.equal(s.value, 72.14);
  assert.equal(s.stale, false);
});

test("snapshot goes stale beyond the freshness window", () => {
  const cp = createCarbonPrice(base);
  const later = Date.parse("2026-10-01T00:00:00Z"); // 20 days later > 14
  assert.equal(cp.isStale(later), true);
  assert.equal(cp.snapshot(later).stale, true);
});

test("resolve() returns cached snapshot when no client price given", () => {
  const cp = createCarbonPrice(base);
  const p = cp.resolve(null, NOW);
  assert.equal(p.value, 72.14);
  assert.equal(p.source, "EU ETS");
});

test("resolve() honours a client-supplied override", () => {
  const cp = createCarbonPrice(base);
  const p = cp.resolve(90, NOW);
  assert.equal(p.value, 90);
  assert.equal(p.source, "client-supplied");
  assert.equal(p.stale, false);
});

test("refresh() updates the price from the fetcher", async () => {
  const cp = createCarbonPrice(base, { fetcher: async () => ({ value: 80, asOf: "2026-09-14", source: "EU ETS" }) });
  const res = await cp.refresh();
  assert.equal(res.ok, true);
  assert.equal(cp.snapshot(NOW).value, 80);
});

test("failed refresh retains the prior price", async () => {
  const cp = createCarbonPrice(base, { fetcher: async () => { throw new Error("network down"); } });
  const res = await cp.refresh();
  assert.equal(res.ok, false);
  assert.equal(cp.snapshot(NOW).value, 72.14); // prior retained
});
