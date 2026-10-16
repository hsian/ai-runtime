/** Coalesce synchronous writes; observers read committed state after transactions finish. */
const listeners = new Set<(jobId: string) => void>();
const pending = new Set<string>();
export function notifyJobChanged(jobId: string): void {
  if (!listeners.size || pending.has(jobId)) return;
  pending.add(jobId);
  queueMicrotask(() => {
    pending.delete(jobId);
    for (const listener of listeners) {
      try { listener(jobId); } catch (cause) { console.warn("[JobChanges] subscriber error", cause); }
    }
  });
}
export function subscribeJobChanges(listener: (jobId: string) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
