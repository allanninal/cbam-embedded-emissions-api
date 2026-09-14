/**
 * EU ETS carbon price cache + freshness (R4, R16.4).
 *
 * Holds the current cached price (EUR/tCO2e) with an `asOf` timestamp and source.
 * A scheduled refresh can update it; a value older than `freshnessWindowDays`
 * is flagged `stale` so a response never silently serves an outdated price
 * (R4.4). A failed refresh RETAINS the prior price and keeps/sets the stale flag.
 *
 * The refresh fetcher is injected (default: none) so the module has no hard
 * network dependency and is trivially testable. In production, wire a fetcher
 * that reads a published EU ETS reference.
 */

function daysBetween(aIso, bMs) {
  const a = Date.parse(aIso);
  if (Number.isNaN(a)) return Infinity;
  return (bMs - a) / 86_400_000;
}

export function createCarbonPrice(initial, { fetcher = null, freshnessWindowDays } = {}) {
  let current = { ...initial };
  const windowDays = freshnessWindowDays ?? initial.freshnessWindowDays ?? 14;
  let timer = null;

  function isStale(now = Date.now()) {
    return daysBetween(current.asOf, now) > windowDays;
  }

  /** The price block to feed the engine, with a computed `stale` flag. */
  function snapshot(now = Date.now()) {
    return {
      value: Number(current.value),
      currency: current.currency || "EUR",
      asOf: current.asOf,
      source: current.source,
      stale: isStale(now)
    };
  }

  /** Resolve the price to use for a request: client override wins (R4.2). */
  function resolve(clientPrice, now = Date.now()) {
    if (clientPrice != null && Number(clientPrice) > 0) {
      return {
        value: Number(clientPrice),
        currency: "EUR",
        asOf: new Date(now).toISOString().slice(0, 10),
        source: "client-supplied",
        stale: false
      };
    }
    return snapshot(now);
  }

  /** Refresh from the injected fetcher; retain prior price on failure (R4.4). */
  async function refresh() {
    if (!fetcher) return { ok: false, reason: "no fetcher configured", price: snapshot() };
    try {
      const next = await fetcher();
      if (next && Number(next.value) > 0 && next.asOf) {
        current = {
          value: Number(next.value),
          currency: next.currency || "EUR",
          asOf: next.asOf,
          source: next.source || current.source,
          freshnessWindowDays: windowDays
        };
        return { ok: true, price: snapshot() };
      }
      return { ok: false, reason: "invalid fetcher result (prior retained)", price: snapshot() };
    } catch (err) {
      return { ok: false, reason: err.message + " (prior retained)", price: snapshot() };
    }
  }

  function startRefreshLoop(intervalMs) {
    if (!fetcher || !intervalMs) return;
    stopRefreshLoop();
    timer = setInterval(() => { refresh().catch(() => {}); }, intervalMs);
    if (typeof timer.unref === "function") timer.unref();
  }
  function stopRefreshLoop() {
    if (timer) { clearInterval(timer); timer = null; }
  }

  return { snapshot, resolve, refresh, isStale, startRefreshLoop, stopRefreshLoop, windowDays };
}
