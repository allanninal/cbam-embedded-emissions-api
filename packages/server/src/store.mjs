/**
 * Persistence for the self-hosted server (R5, R9).
 *
 * SQLite (better-sqlite3) for:
 *   - API keys + daily usage metering (calculations, lines),
 *   - retained calculation records (inputs + derived metadata only — NEVER any PII
 *     or asset bytes; reproducible from the record + pinned dataset versions, R5.5).
 *
 * `better-sqlite3` is a native module; it compiles in the Docker image (Node) but
 * may be unavailable on some local toolchains. Tests therefore use the in-memory
 * fakes in memory-store.mjs and auto-skip the native-backed test where the module
 * isn't compiled — the same pattern as the sibling EUDR / C2PA projects.
 */
import Database from "better-sqlite3";
import crypto from "node:crypto";

export function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

export function openDb(dbPath) {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("busy_timeout = 5000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS api_keys (
      key_hash   TEXT PRIMARY KEY,
      tier       TEXT NOT NULL,
      quota      INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS usage (
      key_hash     TEXT NOT NULL,
      day          TEXT NOT NULL,
      calculations INTEGER NOT NULL DEFAULT 0,
      lines        INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (key_hash, day)
    );
    -- Retained calculation history: inputs + derived metadata only. No PII/bytes.
    CREATE TABLE IF NOT EXISTS calculation_records (
      record_id         TEXT PRIMARY KEY,
      key_hash          TEXT,
      cn_code           TEXT NOT NULL,
      origin_country    TEXT NOT NULL,
      tonnes            REAL NOT NULL,
      certificates_owed INTEGER NOT NULL,
      cost              REAL,
      currency          TEXT,
      record_json       TEXT NOT NULL,
      created_at        TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_calc_key ON calculation_records(key_hash, created_at);
  `);
  return db;
}

export function makeKeyStore(db) {
  const getKey = db.prepare("SELECT tier, quota FROM api_keys WHERE key_hash = ?");
  const getUsage = db.prepare("SELECT calculations, lines FROM usage WHERE key_hash = ? AND day = ?");
  const upsertUsage = db.prepare(`
    INSERT INTO usage (key_hash, day, calculations, lines)
    VALUES (@keyHash, @day, @calculations, @lines)
    ON CONFLICT(key_hash, day) DO UPDATE SET
      calculations = calculations + excluded.calculations,
      lines        = lines        + excluded.lines
  `);
  const insertKey = db.prepare(
    "INSERT OR REPLACE INTO api_keys (key_hash, tier, quota) VALUES (?, ?, ?)"
  );
  const today = () => new Date().toISOString().slice(0, 10);

  return {
    lookup(keyHash) {
      return getKey.get(keyHash) || null;
    },
    usageToday(keyHash) {
      const row = getUsage.get(keyHash, today());
      const calculations = row?.calculations ?? 0;
      const lines = row?.lines ?? 0;
      return { calculations, lines, total: calculations + lines };
    },
    record(keyHash, { calculations = 0, lines = 0 }) {
      upsertUsage.run({ keyHash, day: today(), calculations, lines });
    },
    createKey(rawKey, tier, quota) {
      insertKey.run(sha256(rawKey), tier, quota ?? null);
    }
  };
}

export function makeRecordStore(db) {
  const insert = db.prepare(`
    INSERT OR REPLACE INTO calculation_records
      (record_id, key_hash, cn_code, origin_country, tonnes, certificates_owed, cost, currency, record_json)
    VALUES (@recordId, @keyHash, @cnCode, @originCountry, @tonnes, @certificatesOwed, @cost, @currency, @recordJson)
  `);
  const get = db.prepare("SELECT record_json, key_hash FROM calculation_records WHERE record_id = ?");

  return {
    /** Persist a calculation record. `keyHash` may be null for anonymous callers. */
    put(record, keyHash = null) {
      insert.run({
        recordId: record.recordId,
        keyHash,
        cnCode: record.input.cnCode,
        originCountry: record.input.originCountry,
        tonnes: record.input.tonnes,
        certificatesOwed: record.certificatesOwed,
        cost: record.cost,
        currency: record.currency,
        recordJson: JSON.stringify(record)
      });
      return record.recordId;
    },
    get(recordId) {
      const row = get.get(recordId);
      return row ? { record: JSON.parse(row.record_json), keyHash: row.key_hash ?? null } : null;
    }
  };
}
