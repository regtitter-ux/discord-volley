"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

// Skip-gated redis-variant claimOutcome suite: падать в локальной среде без
// Redis не должен, но если TEST_REDIS_URL задан — проверяем ровно те же
// инварианты, что и LocalBroker (идемпотентность, запрет на разворот).
const REDIS_URL = process.env.TEST_REDIS_URL;
const SKIP = !REDIS_URL;
const opts = SKIP ? { skip: "TEST_REDIS_URL не задан — redis-ветка claimOutcome пропущена" } : {};

test("RedisBroker.claimOutcome: single win, duplicate rejected", opts, async () => {
  const { RedisBroker } = require("../broker.js");
  const b = new RedisBroker({ url: REDIS_URL, instanceId: "test-" + Date.now() });
  await b.init();
  try {
    const mid = "m-redis-" + Date.now() + "-1";
    await b.setStakes(mid, { win: 50, loss: 30 });
    const r1 = await b.claimOutcome(mid, "userA", "win");
    assert.equal(r1.delta, 50);
    const r2 = await b.claimOutcome(mid, "userA", "win");
    assert.equal(r2, null);
  } finally {
    try { await b.pub.quit(); await b.sub.quit(); } catch {}
  }
});

test("RedisBroker.claimOutcome: winner cannot then claim loss", opts, async () => {
  const { RedisBroker } = require("../broker.js");
  const b = new RedisBroker({ url: REDIS_URL, instanceId: "test-" + Date.now() });
  await b.init();
  try {
    const mid = "m-redis-" + Date.now() + "-2";
    await b.setStakes(mid, { win: 40, loss: 20 });
    const r1 = await b.claimOutcome(mid, "userA", "win");
    assert.equal(r1.delta, 40);
    const r2 = await b.claimOutcome(mid, "userA", "loss");
    assert.equal(r2, null, "same user must not claim opposite outcome");
  } finally {
    try { await b.pub.quit(); await b.sub.quit(); } catch {}
  }
});
