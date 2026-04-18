"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { LocalBroker } = require("../broker.js");

test("LocalBroker.claimOutcome: single win, then duplicate win rejected", async () => {
  const b = new LocalBroker();
  await b.init();
  b.setStakes("m1", { win: 50, loss: 30 });
  const r1 = b.claimOutcome("m1", "userA", "win");
  assert.deepEqual(r1, { delta: 50, win: 50, loss: 30 });
  const r2 = b.claimOutcome("m1", "userA", "win");
  assert.equal(r2, null);
});

test("LocalBroker.claimOutcome: winner cannot then claim loss on same match", async () => {
  const b = new LocalBroker();
  await b.init();
  b.setStakes("m2", { win: 40, loss: 20 });
  const r1 = b.claimOutcome("m2", "userA", "win");
  assert.equal(r1.delta, 40);
  const r2 = b.claimOutcome("m2", "userA", "loss");
  assert.equal(r2, null, "same user must not claim opposite outcome");
});

test("LocalBroker.claimOutcome: loser cannot then claim win", async () => {
  const b = new LocalBroker();
  await b.init();
  b.setStakes("m3", { win: 40, loss: 20 });
  const r1 = b.claimOutcome("m3", "userA", "loss");
  assert.equal(r1.delta, -20);
  const r2 = b.claimOutcome("m3", "userA", "win");
  assert.equal(r2, null);
});

test("LocalBroker.claimOutcome: distinct users win/lose independently", async () => {
  const b = new LocalBroker();
  await b.init();
  b.setStakes("m4", { win: 40, loss: 20 });
  const winA = b.claimOutcome("m4", "userA", "win");
  const lossB = b.claimOutcome("m4", "userB", "loss");
  assert.equal(winA.delta, 40);
  assert.equal(lossB.delta, -20);
});

test("LocalBroker.claimOutcome: unknown match returns null", async () => {
  const b = new LocalBroker();
  await b.init();
  const r = b.claimOutcome("does-not-exist", "userA", "win");
  assert.equal(r, null);
});
