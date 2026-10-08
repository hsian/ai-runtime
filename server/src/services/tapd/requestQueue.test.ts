import assert from "node:assert/strict";
import { test } from "node:test";

import { createTapdRequestQueue } from "./requestQueue.js";

function clock() {
  let time = 0;
  const waits: number[] = [];
  return { waits, now: () => time, sleep: async (ms: number) => { waits.push(ms); time += ms; } };
}

test("concurrent callers are serialized with an interval", async () => {
  const timer = clock(), queue = createTapdRequestQueue(timer);
  const starts: number[] = [];
  await Promise.all([1, 2, 3].map(() => queue(async () => {
    starts.push(timer.now());
    return new Response();
  })));
  assert.deepEqual(starts, [0, 500, 1000]);
});

test("429 honors Retry-After and retries before the next caller", async () => {
  const timer = clock(), queue = createTapdRequestQueue(timer);
  let attempts = 0;
  const result = await queue(async () => ++attempts === 1
    ? new Response("limited", { status: 429, headers: { "Retry-After": "3" } }) : new Response());
  assert.equal(result.status, 200);
  assert.equal(attempts, 2);
  assert.deepEqual(timer.waits, [3000]);
  await queue(async () => new Response());
  assert.equal(timer.now(), 3500);
});

test("retry exhaustion retains the shared cooldown", async () => {
  const timer = clock(), queue = createTapdRequestQueue(timer);
  let attempts = 0;
  const response = await queue(async () => { attempts++; return new Response(null, { status: 429 }); });
  assert.equal(response.status, 429);
  assert.equal(attempts, 4);
  assert.deepEqual(timer.waits, [2000, 4000, 8000]);
  await queue(async () => new Response());
  assert.equal(timer.waits.at(-1), 16000);
});

test("network failure does not poison the queue", async () => {
  const timer = clock(), queue = createTapdRequestQueue(timer);
  await assert.rejects(queue(async () => { throw new Error("network failure"); }), /network failure/);
  assert.equal((await queue(async () => new Response())).status, 200);
});
