/**
 * Express app factory for the self-hosted CBAM embedded-emissions API.
 *
 * Separated from server.mjs so tests can inject fakes (in-memory stores, an
 * in-memory rate-limit backend, fixture datasets, a fixed carbon price) and
 * exercise the real HTTP surface without native deps.
 *
 * Public/free model (same as the sibling EUDR and C2PA APIs): anonymous access is
 * allowed; requests are metered by validated API-key hash when present, else by
 * client IP. Per-IP rate limiting is enforced primarily at the shared APISIX
 * gateway; the app-side limiter is defense-in-depth.
 */
import express from "express";
import crypto from "node:crypto";
import { calculateLine, calculateDeclaration } from "./calc.mjs";
import { makeCalculationRecord } from "./audit.mjs";
import { createWindow, rateLimit, createMemoryBackend } from "./rate-limit.mjs";

const MAX_BATCH = 1000;

/**
 * @param {object} opts
 * @param {object} opts.keys       key store (lookup, usageToday, record, createKey)
 * @param {object} opts.records    calculation-record store (put, get)
 * @param {object} opts.datasets   loaded reference datasets ({ cnCodes, defaultValues, countryFactors, meta })
 * @param {object} opts.carbonPrice carbon-price service ({ resolve, snapshot, isStale })
 * @param {boolean} [opts.requireKey=false]  public mode when false
 * @param {(t:string)=>string} [opts.hashFn]
 * @param {string} [opts.staticDir]
 * @param {number|boolean} [opts.trustProxy=1]
 * @param {object} [opts.rateLimit]
 * @param {{name:string,version:string}} [opts.serviceInfo]
 */
export function createApp(opts = {}) {
  const {
    keys, records, datasets, carbonPrice,
    requireKey = false, staticDir, trustProxy = 1,
    serviceInfo = { name: "cbam-embedded-emissions-api", version: "1.0.0" }
  } = opts;
  const rl = opts.rateLimit || {};
  const sha256 = opts.hashFn || ((t) => crypto.createHash("sha256").update(t).digest("hex"));
  const deMinimisTonnes = datasets.meta?.deMinimisTonnes ?? 50;

  const app = express();
  app.set("trust proxy", trustProxy);
  app.use(express.json({ limit: "1mb" }));

  app.use((req, res, next) => {
    res.set("access-control-allow-origin", "*");
    res.set("access-control-allow-methods", "GET,POST,OPTIONS");
    res.set("access-control-allow-headers", "authorization,content-type");
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  });

  app.get("/healthz", (_req, res) => {
    const price = carbonPrice.snapshot();
    res.json({
      ok: true,
      datasets: {
        cnMapping: datasets.cnCodes?.version,
        defaultValues: datasets.defaultValues?.version,
        countryFactors: datasets.countryFactors?.version
      },
      carbonPrice: { asOf: price.asOf, stale: price.stale },
      ts: new Date().toISOString()
    });
  });

  // --- identity (parse bearer once; unknown tokens are anonymous) ---
  function identify(req) {
    if (req._identity) return req._identity;
    const raw = (req.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
    let identity = { validKey: false, keyHash: null, tier: "anonymous", quota: null };
    if (raw) {
      const keyHash = sha256(raw);
      const row = keys.lookup(keyHash);
      if (row) identity = { validKey: true, keyHash, tier: row.tier, quota: row.quota };
    }
    req._identity = identity;
    return identity;
  }

  // --- rate limiting ---
  const rlEnabled = rl.enabled !== false;
  const anonPerMinute = rl.perMinute ?? 60;
  const anonPerDay = rl.perDay ?? 5000;
  const keyPerMinute = rl.keyPerMinute ?? anonPerMinute * 5;
  const keyPerDay = rl.keyPerDay ?? anonPerDay * 10;
  const backend = rl.backend ?? createMemoryBackend();

  const anonMinute = createWindow({ windowMs: 60_000, max: anonPerMinute, name: "anon-min", backend });
  const anonDay = createWindow({ windowMs: 86_400_000, max: anonPerDay, name: "anon-day", backend });
  const keyMinute = createWindow({ windowMs: 60_000, max: keyPerMinute, name: "key-min", backend });
  const keyDay = createWindow({ windowMs: 86_400_000, max: keyPerDay, name: "key-day", backend });

  const keyFn = (req) => {
    const id = identify(req);
    return id.validKey ? "key:" + id.keyHash : "ip:" + (req.ip || "unknown");
  };
  // Cost = 1 unit per line (batch = number of lines) (R3.4, R9.4).
  const costFn = (req) => (Array.isArray(req.body?.lines) ? Math.max(1, req.body.lines.length) : 1);
  const anonLimiter = rateLimit({ enabled: rlEnabled, keyFn, costFn, windows: [anonMinute, anonDay] });
  const keyedLimiter = rateLimit({ enabled: rlEnabled, keyFn, costFn, windows: [keyMinute, keyDay] });
  const limiter = (req, res, next) => {
    if (!rlEnabled) return next();
    return (identify(req).validKey ? keyedLimiter : anonLimiter)(req, res, next);
  };

  function auth(req, res, next) {
    const id = identify(req);
    if (!requireKey) {
      req.auth = id.validKey
        ? { keyHash: id.keyHash, tier: id.tier, quota: id.quota }
        : { keyHash: "ip:" + (req.ip || "unknown"), tier: "anonymous", quota: null };
      return next();
    }
    const hasBearer = !!(req.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
    if (!hasBearer) return res.status(401).json({ error: "missing API key (Authorization: Bearer <key>)" });
    if (!id.validKey) return res.status(401).json({ error: "invalid API key" });
    const used = keys.usageToday(id.keyHash);
    if (id.quota != null && used.total >= id.quota) {
      return res.status(429).json({ error: "quota exceeded", tier: id.tier, quota: id.quota });
    }
    req.auth = { keyHash: id.keyHash, tier: id.tier, quota: id.quota };
    next();
  }

  const isAnon = (keyHash) => String(keyHash).startsWith("ip:");

  // --- validate a single line input; returns { ok, error } ---
  function validateLine(body) {
    if (!body || typeof body !== "object") return { ok: false, error: "request body required" };
    const { cnCode, originCountry, tonnes } = body;
    if (typeof cnCode !== "string" || !/^[0-9 .]{4,14}$/.test(cnCode)) {
      return { ok: false, error: "cnCode must be a Combined Nomenclature code (6-10 digits)" };
    }
    if (typeof originCountry !== "string" || !/^[A-Za-z]{2}$/.test(originCountry)) {
      return { ok: false, error: "originCountry must be an ISO 3166-1 alpha-2 code" };
    }
    if (typeof tonnes !== "number" || !(tonnes > 0) || !Number.isFinite(tonnes)) {
      return { ok: false, error: "tonnes must be a positive number" };
    }
    if (body.carbonPrice != null) {
      const cp = Number(body.carbonPrice);
      if (!(cp > 0) || !Number.isFinite(cp) || cp > 100000) {
        return { ok: false, error: "carbonPrice, if provided, must be a positive number below 100000 EUR/tCO2e" };
      }
    }
    return { ok: true };
  }

  // --- POST /v1/calculate ---
  app.post("/v1/calculate", limiter, auth, (req, res, next) => {
    try {
      const v = validateLine(req.body);
      if (!v.ok) return res.status(400).json({ error: v.error });

      const price = carbonPrice.resolve(req.body.carbonPrice);
      const result = calculateLine(req.body, datasets, price, { deMinimisTonnes });
      if (req.body.importYear != null) result.importYear = req.body.importYear;

      keys.record(req.auth.keyHash, { calculations: 1 });

      const record = makeCalculationRecord(result, { service: serviceInfo });
      if (!isAnon(req.auth.keyHash) && records?.put) {
        records.put(record, req.auth.keyHash);
      }
      res.json({ ...result, recordId: record.recordId });
    } catch (err) { next(err); }
  });

  // --- POST /v1/declarations/calculate --- ({ lines: [...], importYear? })
  app.post("/v1/declarations/calculate", limiter, auth, (req, res, next) => {
    try {
      const lines = Array.isArray(req.body?.lines) ? req.body.lines : null;
      if (!lines || lines.length === 0) return res.status(400).json({ error: "lines[] required" });
      if (lines.length > MAX_BATCH) return res.status(400).json({ error: `max ${MAX_BATCH} lines per declaration` });

      // Validate each line; invalid lines are captured as per-line errors (partial results, R3.3).
      const prepared = lines.map((line) => {
        const v = validateLine(line);
        return v.ok ? { line } : { error: v.error, line };
      });
      const okLines = prepared.filter((p) => !p.error).map((p) => p.line);
      const price = carbonPrice.resolve(null);
      const computed = calculateDeclaration(okLines, datasets, price, { deMinimisTonnes });

      // Re-interleave per-line validation errors in the original order.
      let ci = 0;
      const merged = prepared.map((p) =>
        p.error ? { lineId: p.line.lineId ?? null, cnCode: p.line.cnCode, error: p.error } : computed.lines[ci++]
      );

      keys.record(req.auth.keyHash, { calculations: 1, lines: lines.length });
      res.json({ lines: merged, aggregate: computed.aggregate, assessedAt: new Date().toISOString() });
    } catch (err) { next(err); }
  });

  // --- GET /v1/calculations/:id --- (retained records, ownership-scoped) ---
  // A record written under a validated key is only returned to that same key;
  // anonymous-written records (keyHash null) are retrievable by opaque id. This
  // prevents one key holder from reading another key holder's calculations.
  app.get("/v1/calculations/:id", auth, (req, res) => {
    const stored = records?.get ? records.get(req.params.id) : null;
    if (!stored) return res.status(404).json({ error: "calculation record not found" });
    const ownerKeyHash = stored.keyHash ?? null;
    const callerKeyHash = String(req.auth.keyHash).startsWith("ip:") ? null : req.auth.keyHash;
    if (ownerKeyHash && ownerKeyHash !== callerKeyHash) {
      return res.status(404).json({ error: "calculation record not found" });
    }
    res.json(stored.record);
  });

  // --- GET /v1/usage ---
  app.get("/v1/usage", auth, (req, res) => {
    res.json({ tier: req.auth.tier, quota: req.auth.quota, ...keys.usageToday(req.auth.keyHash) });
  });

  // Serve the LIVE carbon-price snapshot, overriding the static build-time copy,
  // so a caller always sees the price the running service is actually using.
  app.get("/api/v1/carbon-price.json", (_req, res) => res.json(carbonPrice.snapshot()));

  if (staticDir) app.use(express.static(staticDir, { extensions: ["html"] }));

  // Centralized error handler.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    if (err?.type === "entity.too.large" || err?.status === 413) {
      return res.status(413).json({ error: "request body too large" });
    }
    if (err?.status === 400 || err?.type === "entity.parse.failed") {
      return res.status(400).json({ error: "invalid JSON body" });
    }
    console.error("unhandled error:", err?.stack || err);
    res.status(500).json({ error: "internal server error" });
  });

  return app;
}
