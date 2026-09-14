/**
 * In-memory stand-ins for the SQLite stores (store.mjs), used by tests and local
 * dev when the native `better-sqlite3` module isn't compiled. They implement the
 * exact same interfaces as makeKeyStore / makeRecordStore so the app is unaware of
 * which backend it's running on.
 */
import crypto from "node:crypto";

export function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

export function makeMemoryKeyStore(seed = {}) {
  // seed: { keys: { <keyHash>: { tier, quota } } }
  const keys = new Map(Object.entries(seed.keys || {}));
  const usage = new Map(); // `${keyHash}:${day}` -> { calculations, lines }
  const today = () => new Date().toISOString().slice(0, 10);

  return {
    lookup(keyHash) {
      return keys.get(keyHash) || null;
    },
    usageToday(keyHash) {
      const u = usage.get(`${keyHash}:${today()}`) || { calculations: 0, lines: 0 };
      return { ...u, total: u.calculations + u.lines };
    },
    record(keyHash, { calculations = 0, lines = 0 }) {
      const k = `${keyHash}:${today()}`;
      const u = usage.get(k) || { calculations: 0, lines: 0 };
      u.calculations += calculations;
      u.lines += lines;
      usage.set(k, u);
    },
    createKey(rawKey, tier, quota) {
      keys.set(sha256(rawKey), { tier, quota: quota ?? null });
    },
    _keys: keys
  };
}

export function makeMemoryRecordStore() {
  const records = new Map(); // recordId -> { record, keyHash }
  return {
    put(record, keyHash = null) {
      records.set(record.recordId, { record, keyHash });
      return record.recordId;
    },
    get(recordId) {
      return records.get(recordId)?.record || null;
    },
    _records: records
  };
}
