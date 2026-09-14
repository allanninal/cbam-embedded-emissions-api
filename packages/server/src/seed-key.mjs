/**
 * Issue an API key for the compute endpoints and print it once.
 *
 * Usage:
 *   node packages/server/src/seed-key.mjs <tier> [dailyQuota]
 *   node packages/server/src/seed-key.mjs broker 200000
 *
 * The raw key is printed to stdout; only its SHA-256 hash is stored. Keep the
 * printed value — it cannot be recovered.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import { openDb, makeKeyStore } from "./store.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "../data/cbam.sqlite");

const tier = process.argv[2] || "broker";
const quota = process.argv[3] != null ? Number(process.argv[3]) : null;

const rawKey = "cbam_" + crypto.randomBytes(24).toString("hex");
const db = openDb(DB_PATH);
const keys = makeKeyStore(db);
keys.createKey(rawKey, tier, quota);
db.close();

console.log("API key created (store this now — it is not recoverable):");
console.log(`  tier:  ${tier}`);
console.log(`  quota: ${quota ?? "unlimited (per-key daily)"}`);
console.log(`  key:   ${rawKey}`);
