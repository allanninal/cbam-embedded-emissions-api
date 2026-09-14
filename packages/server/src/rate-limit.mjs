/**
 * Rate limiter (fixed-window) for a public, free API, with a pluggable backend.
 *
 * Ported from the sibling EUDR / C2PA APIs (same shared-server pattern); the only
 * project-specific change is the default Redis key prefix (`cbam:rl:`) so the
 * shared Redis instance can serve this and the other projects without collisions.
 *
 * Backends implement the same async interface:
 *   incr(fullKey, windowMs, cost) -> { count, resetAtMs }
 *
 * - In-memory backend (default): zero dependencies, correct for a single node.
 * - Redis backend: shared across processes/instances. Selected when a Redis
 *   client is provided.
 *
 * Keying is by API key when present, else client IP, so anonymous public users
 * are limited per-IP while key holders get their own (higher) budget.
 *
 * NOTE: in production, per-IP limiting is enforced primarily at the shared APISIX
 * gateway (limit-count, policy: redis, prefix cbam:gw:). This app-side limiter is
 * defense-in-depth and for non-gateway deploys; it FAILS OPEN on backend errors.
 */

/* --------------------------- Backends --------------------------- */

/** In-memory fixed-window backend. */
export function createMemoryBackend() {
  /** @type {Map<string, { count: number, resetAt: number }>} */
  const buckets = new Map();

  async function incr(fullKey, windowMs, cost, now = Date.now()) {
    let b = buckets.get(fullKey);
    if (!b || now >= b.resetAt) {
      b = { count: 0, resetAt: now + windowMs };
      buckets.set(fullKey, b);
    }
    b.count += cost;
    return { count: b.count, resetAtMs: b.resetAt };
  }

  async function incrMulti(entries, now = Date.now()) {
    return Promise.all(entries.map((e) => incr(e.fullKey, e.windowMs, e.cost, now)));
  }

  function sweep(now = Date.now()) {
    for (const [k, b] of buckets) if (now >= b.resetAt) buckets.delete(k);
  }

  return { kind: "memory", incr, incrMulti, sweep, _buckets: buckets };
}

/**
 * Redis fixed-window backend using atomic Lua scripts.
 * `incrMulti` folds ALL windows for a request into a SINGLE EVAL (one round-trip).
 *
 * @param {object} redis  a connected `redis` client (node-redis v4)
 * @param {string} [prefix="cbam:rl:"]  key prefix; each project on the shared Redis
 *   MUST use its own prefix to avoid collisions.
 */
export function createRedisBackend(redis, prefix = "cbam:rl:") {
  const script = `
    local c = redis.call('INCRBY', KEYS[1], tonumber(ARGV[1]))
    if c == tonumber(ARGV[1]) then
      redis.call('EXPIRE', KEYS[1], tonumber(ARGV[2]))
    end
    local ttl = redis.call('PTTL', KEYS[1])
    return {c, ttl}
  `;

  const multiScript = `
    local out = {}
    for i = 1, #KEYS do
      local cost = tonumber(ARGV[(i-1)*2 + 1])
      local win  = tonumber(ARGV[(i-1)*2 + 2])
      local c = redis.call('INCRBY', KEYS[i], cost)
      if c == cost then
        redis.call('EXPIRE', KEYS[i], win)
      end
      local ttl = redis.call('PTTL', KEYS[i])
      out[#out+1] = c
      out[#out+1] = ttl
    end
    return out
  `;

  async function incr(fullKey, windowMs, cost, now = Date.now()) {
    const windowSec = Math.ceil(windowMs / 1000);
    const res = await redis.eval(script, {
      keys: [prefix + fullKey],
      arguments: [String(cost), String(windowSec)]
    });
    const count = Number(res[0]);
    let ttl = Number(res[1]);
    if (ttl < 0) ttl = windowMs;
    return { count, resetAtMs: now + ttl };
  }

  async function incrMulti(entries, now = Date.now()) {
    if (entries.length === 1) return [await incr(entries[0].fullKey, entries[0].windowMs, entries[0].cost, now)];
    const keys = entries.map((e) => prefix + e.fullKey);
    const args = entries.flatMap((e) => [String(e.cost), String(Math.ceil(e.windowMs / 1000))]);
    const res = await redis.eval(multiScript, { keys, arguments: args });
    const out = [];
    for (let i = 0; i < entries.length; i++) {
      const count = Number(res[i * 2]);
      let ttl = Number(res[i * 2 + 1]);
      if (ttl < 0) ttl = entries[i].windowMs;
      out.push({ count, resetAtMs: now + ttl });
    }
    return out;
  }

  function sweep() {}

  return { kind: "redis", incr, incrMulti, sweep };
}

/* --------------------------- Windows --------------------------- */

/**
 * A single fixed window bound to a backend.
 * @param {object} rule
 * @param {number} rule.windowMs
 * @param {number} rule.max
 * @param {string} [rule.name]
 * @param {object} rule.backend
 */
export function createWindow({ windowMs, max, name = "window", backend }) {
  if (!backend) backend = createMemoryBackend();

  async function hit(key, cost = 1, now = Date.now()) {
    const { count, resetAtMs } = await backend.incr(`${name}:${key}`, windowMs, cost, now);
    const allowed = count <= max;
    return {
      allowed,
      limit: max,
      remaining: Math.max(0, max - count),
      resetAt: resetAtMs,
      retryAfterSec: Math.max(1, Math.ceil((resetAtMs - now) / 1000)),
      name
    };
  }

  const sweep = (now) => backend.sweep(now);
  return { hit, sweep, backend, windowMs, max, name, _buckets: backend._buckets };
}

/* --------------------------- Middleware --------------------------- */

/**
 * Build an Express middleware enforcing one or more windows (async).
 *
 * @param {object} opts
 * @param {Array} opts.windows
 * @param {(req)=>string} [opts.keyFn]
 * @param {(req)=>number} [opts.costFn]
 * @param {boolean} [opts.enabled=true]
 */
export function rateLimit({ windows, keyFn, costFn, enabled = true }) {
  const getKey = keyFn || defaultKey;
  const getCost = costFn || (() => 1);
  const backend = windows[0]?.backend;

  const timer = setInterval(() => windows.forEach((w) => w.sweep()), 60_000);
  if (typeof timer.unref === "function") timer.unref();

  return async function rateLimitMiddleware(req, res, next) {
    if (!enabled) return next();
    try {
      const key = getKey(req);
      const cost = Math.max(1, getCost(req));
      const now = Date.now();

      const entries = windows.map((w) => ({
        fullKey: `${w.name}:${key}`,
        windowMs: w.windowMs,
        cost
      }));
      const raw = backend?.incrMulti
        ? await backend.incrMulti(entries, now)
        : await Promise.all(windows.map((w, i) => w.backend.incr(entries[i].fullKey, w.windowMs, cost, now)));

      let blocked = null;
      let tightest = null;
      for (let i = 0; i < windows.length; i++) {
        const w = windows[i];
        const { count, resetAtMs } = raw[i];
        const r = {
          allowed: count <= w.max,
          limit: w.max,
          remaining: Math.max(0, w.max - count),
          resetAt: resetAtMs,
          retryAfterSec: Math.max(1, Math.ceil((resetAtMs - now) / 1000)),
          name: w.name
        };
        if (!tightest || r.remaining < tightest.remaining) tightest = r;
        if (!r.allowed && (!blocked || r.resetAt > blocked.resetAt)) blocked = r;
      }

      const info = blocked || tightest;
      res.set("RateLimit-Limit", String(info.limit));
      res.set("RateLimit-Remaining", String(info.remaining));
      res.set("RateLimit-Reset", String(Math.ceil((info.resetAt - Date.now()) / 1000)));

      if (blocked) {
        res.set("Retry-After", String(blocked.retryAfterSec));
        return res.status(429).json({
          error: "rate limit exceeded",
          window: blocked.name,
          limit: blocked.limit,
          retryAfterSeconds: blocked.retryAfterSec
        });
      }
      next();
    } catch (err) {
      // Fail open: a limiter/backend outage must not take down the API.
      next();
    }
  };
}

/** Default key: API key (if any) takes priority, else client IP. */
export function defaultKey(req) {
  const raw = (req.get?.("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (raw) return "key:" + raw;
  return "ip:" + clientIp(req);
}

/** Resolve the real client IP behind a trusted reverse proxy. */
export function clientIp(req) {
  if (req.ip) return req.ip;
  const xff = req.get?.("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  return req.socket?.remoteAddress || "unknown";
}
