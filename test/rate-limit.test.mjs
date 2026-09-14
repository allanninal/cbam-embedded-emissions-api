import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryBackend, createWindow } from "../packages/server/src/rate-limit.mjs";

test("window allows up to max then blocks", async () => {
  const backend = createMemoryBackend();
  const w = createWindow({ windowMs: 60_000, max: 3, name: "t", backend });
  const now = Date.now();
  assert.equal((await w.hit("ip:1", 1, now)).allowed, true);
  assert.equal((await w.hit("ip:1", 1, now)).allowed, true);
  assert.equal((await w.hit("ip:1", 1, now)).allowed, true);
  const fourth = await w.hit("ip:1", 1, now);
  assert.equal(fourth.allowed, false);
  assert.equal(fourth.remaining, 0);
});

test("cost > 1 consumes multiple units (batch = lines)", async () => {
  const backend = createMemoryBackend();
  const w = createWindow({ windowMs: 60_000, max: 10, name: "b", backend });
  const now = Date.now();
  const r = await w.hit("ip:2", 8, now);
  assert.equal(r.allowed, true);
  assert.equal(r.remaining, 2);
  const r2 = await w.hit("ip:2", 5, now);
  assert.equal(r2.allowed, false);
});

test("window resets after the interval", async () => {
  const backend = createMemoryBackend();
  const w = createWindow({ windowMs: 1000, max: 1, name: "r", backend });
  const t0 = 1_000_000;
  assert.equal((await w.hit("ip:3", 1, t0)).allowed, true);
  assert.equal((await w.hit("ip:3", 1, t0)).allowed, false);
  assert.equal((await w.hit("ip:3", 1, t0 + 2000)).allowed, true);
});

test("separate keys have separate budgets", async () => {
  const backend = createMemoryBackend();
  const w = createWindow({ windowMs: 60_000, max: 1, name: "k", backend });
  const now = Date.now();
  assert.equal((await w.hit("ip:a", 1, now)).allowed, true);
  assert.equal((await w.hit("ip:b", 1, now)).allowed, true);
});
