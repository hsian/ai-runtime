import type { TapdBatchCommand } from "./tapdBatchMessages.js";

export async function sendTapdBatchCommand<T = unknown>(command: TapdBatchCommand): Promise<T> {
  return chrome.runtime.sendMessage(command) as Promise<T>;
}
