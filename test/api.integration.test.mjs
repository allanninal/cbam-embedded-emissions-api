import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../packages/server/src/app.mjs";
import { makeMemoryKeyStore, makeMemoryRecordStore, sha256 } from "../packages/server/src/memory-store.mjs";
import { createMemoryBackend } from "../packages/server/src/rate-limit.mjs";
import { createCarbonPrice } from "../packages/server/src/carbon-price.mjs";
import { fixtureDatasets, fixtureCarbonPrice } from "./fixtures.mjs";

/**
 * Boot the app on an ephemeral port with in-memory backends + fixture datasets,
 * run fn(ctx), and always close the server.
 */
async function withApp({ requireKey = false, rateLimit } = {}, fn) {
  const keys = makeMemoryKeyStore({ keys: { [sha256("secret")]: { tier: "pro", quota: 100000 } } });
  const records = makeMemoryRecordStore();
  const carbonPrice = createCarbonPrice(fixtureCarbonPrice);
  const app = createApp({
    keys, records, datasets: fixtureDatasets, carbonPrice,
    requireKey,
    rateLimit: { backend: createMemoryBackend(), perMinute: 5, perDay: 1000, ...(rateLimit || {}) }
  });
  const server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  try { return await fn({ base, keys, records }); }
  finally { await new Promise((r) => server.close(r)); }
}

const calc = (base, body, headers = {}) =>
  fetch(base + "/v1/calculate", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

test("POST /v1/calculate returns emissions, certificates, cost, and audit trail", async () => {
  await withApp({}, async ({ base }) => {
    const res = await calc(base, { cnCode: "72071110", originCountry: "IN", tonnes: 120, importYear: 2026 });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.inScope, true);
    assert.equal(body.embeddedEmissions.value, 240);
    assert.equal(body.markup.pct, 0.10);
    assert.equal(body.certificatesOwed, 264); // 240 * 1.10 default-value markup
    assert.equal(body.cost.value, 18480);      // 264 * 70
    assert.equal(body.auditTrail.length, 7);
    assert.ok(body.recordId);
    assert.equal(body.datasetVersions.cnMapping, "cn-test.1");
  });
});

test("bad ISO2 → 400", async () => {
  await withApp({}, async ({ base }) => {
    const res = await calc(base, { cnCode: "72071110", originCountry: "India", tonnes: 120 });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /ISO 3166/);
  });
});

test("non-positive tonnes → 400", async () => {
  await withApp({}, async ({ base }) => {
    const res = await calc(base, { cnCode: "72071110", originCountry: "IN", tonnes: 0 });
    assert.equal(res.status, 400);
  });
});

test("out-of-scope CN code → inScope false, out-of-scope", async () => {
  await withApp({}, async ({ base }) => {
    const body = await (await calc(base, { cnCode: "99999999", originCountry: "IN", tonnes: 100 })).json();
    assert.equal(body.inScope, false);
    assert.equal(body.reason, "out-of-scope");
  });
});

test("below de-minimis → inScope false, below-de-minimis, 0 certificates", async () => {
  await withApp({}, async ({ base }) => {
    const body = await (await calc(base, { cnCode: "72071110", originCountry: "IN", tonnes: 10 })).json();
    assert.equal(body.inScope, false);
    assert.equal(body.reason, "below-de-minimis");
    assert.equal(body.certificatesOwed, 0);
  });
});

test("declaration returns per-line + aggregate, partial results on bad line", async () => {
  await withApp({}, async ({ base }) => {
    const res = await fetch(base + "/v1/declarations/calculate", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ lines: [
        { lineId: "a", cnCode: "72071110", originCountry: "IN", tonnes: 120 },
        { lineId: "b", cnCode: "72071110", originCountry: "BAD", tonnes: 50 }
      ] })
    });
    const body = await res.json();
    assert.equal(body.lines.length, 2);
    assert.ok(body.lines[1].error); // invalid line captured, not a whole-batch failure
    assert.equal(body.aggregate.linesInScope, 1);
  });
});

test("record retrievable by id for key holders; usage reflects metering", async () => {
  await withApp({}, async ({ base }) => {
    const auth = { authorization: "Bearer secret" };
    const body = await (await calc(base, { cnCode: "72071110", originCountry: "IN", tonnes: 120 }, auth)).json();
    const got = await (await fetch(base + "/v1/calculations/" + body.recordId, { headers: auth })).json();
    assert.equal(got.recordId, body.recordId);
    const usage = await (await fetch(base + "/v1/usage", { headers: auth })).json();
    assert.equal(usage.calculations, 1);
    assert.equal(usage.tier, "pro");
  });
});

test("anonymous calculations are not retained server-side", async () => {
  await withApp({}, async ({ base }) => {
    const body = await (await calc(base, { cnCode: "72071110", originCountry: "IN", tonnes: 120 })).json();
    const res = await fetch(base + "/v1/calculations/" + body.recordId);
    assert.equal(res.status, 404);
  });
});

test("rate limit returns 429 with headers after the per-minute budget", async () => {
  await withApp({}, async ({ base }) => {
    let last;
    for (let i = 0; i < 7; i++) last = await calc(base, { cnCode: "72071110", originCountry: "IN", tonnes: 120 });
    assert.equal(last.status, 429);
    assert.ok(last.headers.get("retry-after"));
  });
});

test("healthz reports ok, dataset versions, and carbon-price freshness", async () => {
  await withApp({}, async ({ base }) => {
    const body = await (await fetch(base + "/healthz")).json();
    assert.equal(body.ok, true);
    assert.equal(body.datasets.cnMapping, "cn-test.1");
    assert.equal(body.carbonPrice.stale, false);
  });
});
