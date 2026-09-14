/**
 * Self-hosted CBAM embedded-emissions API entrypoint (Node/Express).
 * Serves BOTH tiers from one origin:
 *   - Static tier:  GET /api/v1/*.json, /, /openapi.yaml   (from dist/)
 *   - Compute tier: POST /v1/calculate, /v1/declarations/calculate;
 *                   GET /v1/calculations/:id, /v1/usage
 *
 * Env:
 *   PORT                 (default 8792)
 *   DB_PATH              (default ./data/cbam.sqlite)
 *   DATA_DIR             (default ../../../data)
 *   STATIC_DIR           (default ../../../dist)
 *   REQUIRE_KEY          ("false" for public/anonymous — default; the reference model)
 *   RATE_LIMIT           ("true"/"false"; default true)
 *   RL_PER_MINUTE / RL_PER_DAY               (anon limits; default 60 / 5000)
 *   RL_KEY_PER_MINUTE / RL_KEY_PER_DAY       (key holders; default 5× / 10×)
 *   REDIS_URL            (shared rate-limit store; falls back to in-memory)
 *   REDIS_PREFIX         (default "cbam:rl:")
 *   CARBON_PRICE_REFRESH_MS  (scheduled refresh interval; 0 disables — default 0)
 *   TRUST_PROXY          (default 1)
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDb, makeKeyStore, makeRecordStore } from "./store.mjs";
import { createApp } from "./app.mjs";
import { loadDatasets, loadCarbonPriceDoc } from "./datasets.mjs";
import { createCarbonPrice } from "./carbon-price.mjs";
import { createMemoryBackend, createRedisBackend } from "./rate-limit.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8792);
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "../data/cbam.sqlite");
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "../../../data");
const STATIC_DIR = process.env.STATIC_DIR || path.join(__dirname, "../../../dist");
const REQUIRE_KEY = (process.env.REQUIRE_KEY ?? "false") !== "false";
const REDIS_URL = process.env.REDIS_URL || "";
const REDIS_PREFIX = process.env.REDIS_PREFIX || "cbam:rl:";
const CARBON_PRICE_REFRESH_MS = Number(process.env.CARBON_PRICE_REFRESH_MS || 0);
const TRUST_PROXY = process.env.TRUST_PROXY ?? "1";
const trustProxy = /^\d+$/.test(String(TRUST_PROXY)) ? Number(TRUST_PROXY) : TRUST_PROXY;
const num = (v, d) => (v == null || v === "" ? d : Number(v));

async function makeRateLimitBackend() {
  if (!REDIS_URL) return { backend: createMemoryBackend(), label: "in-memory", client: null };
  try {
    const { createClient } = await import("redis");
    const client = createClient({ url: REDIS_URL });
    client.on("error", (e) => console.error("redis error:", e.message));
    await client.connect();
    await client.ping();
    return {
      backend: createRedisBackend(client, REDIS_PREFIX),
      label: `redis (${REDIS_URL.replace(/:[^:@/]*@/, ":****@")}, prefix=${REDIS_PREFIX})`,
      client
    };
  } catch (err) {
    console.error(`Redis unavailable (${err.message}); falling back to in-memory rate limiting.`);
    return { backend: createMemoryBackend(), label: "in-memory (redis fallback)", client: null };
  }
}

const { backend, label, client: redisClient } = await makeRateLimitBackend();

const db = openDb(DB_PATH);
const keys = makeKeyStore(db);
const records = makeRecordStore(db);
const datasets = loadDatasets(DATA_DIR);
const carbonPrice = createCarbonPrice(loadCarbonPriceDoc(DATA_DIR));
if (CARBON_PRICE_REFRESH_MS > 0) carbonPrice.startRefreshLoop(CARBON_PRICE_REFRESH_MS);

const rateLimitCfg = {
  enabled: (process.env.RATE_LIMIT ?? "true") !== "false",
  perMinute: num(process.env.RL_PER_MINUTE, 60),
  perDay: num(process.env.RL_PER_DAY, 5000),
  keyPerMinute: num(process.env.RL_KEY_PER_MINUTE, undefined),
  keyPerDay: num(process.env.RL_KEY_PER_DAY, undefined),
  backend
};

const app = createApp({
  keys, records, datasets, carbonPrice,
  requireKey: REQUIRE_KEY, staticDir: STATIC_DIR, trustProxy,
  rateLimit: rateLimitCfg
});

const price = carbonPrice.snapshot();
const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`CBAM embedded-emissions API listening on :${PORT} (auth ${REQUIRE_KEY ? "required" : "public/anonymous"})`);
  console.log(`  rate limit: ${rateLimitCfg.enabled ? `${rateLimitCfg.perMinute}/min, ${rateLimitCfg.perDay}/day per client` : "disabled"} [store: ${label}]`);
  console.log(`  datasets: cn=${datasets.cnCodes.version} dv=${datasets.defaultValues.version} cf=${datasets.countryFactors.version}`);
  console.log(`  carbon price: ${price.value} ${price.currency}/tCO2e asOf ${price.asOf}${price.stale ? " (STALE)" : ""}`);
  console.log(`  db: ${DB_PATH}  static: ${STATIC_DIR}`);
});

// Graceful shutdown (R16.2).
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received — shutting down gracefully...`);
  const force = setTimeout(() => { console.error("shutdown timed out; forcing exit"); process.exit(1); }, 10_000);
  force.unref();
  carbonPrice.stopRefreshLoop();
  server.close(async () => {
    try { if (redisClient) await redisClient.quit(); } catch (e) { console.error("redis quit error:", e.message); }
    try { db.close(); } catch (e) { console.error("db close error:", e.message); }
    clearTimeout(force);
    console.log("shutdown complete");
    process.exit(0);
  });
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
