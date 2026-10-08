import { setTimeout as delay } from "node:timers/promises";

export function createTapdRequestQueue({
  intervalMs = 500,
  now = Date.now,
  sleep = (ms: number) => delay(ms),
} = {}) {
  let tail: Promise<unknown> = Promise.resolve();
  let nextRequestAt = 0;
  return (send: () => Promise<Response>): Promise<Response> => {
    const pending = tail.then(async () => {
      for (let attempt = 0; ; attempt++) {
        const wait = nextRequestAt - now();
        if (wait > 0) await sleep(wait);
        nextRequestAt = now() + intervalMs;
        const response = await send();
        if (response.status !== 429) return response;
        const retryAfter = response.headers.get("Retry-After");
        const seconds = retryAfter === null ? NaN : Number(retryAfter);
        const retryAt = Number.isFinite(seconds) ? now() + Math.max(0, seconds * 1000) : Date.parse(retryAfter ?? "");
        const backoff = Number.isFinite(retryAt) ? retryAt : now() + 2000 * 2 ** attempt;
        nextRequestAt = Math.max(nextRequestAt, backoff);
        if (attempt >= 3) return response;
        await response.body?.cancel();
      }
    });
    // A failed request must not prevent subsequent operations from running.
    tail = pending.catch(() => undefined);
    return pending;
  };
}

export const queueWorkHoursRequest = createTapdRequestQueue();
