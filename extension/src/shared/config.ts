import type { StorageConfig } from "./types.js";

export async function loadConfig(): Promise<StorageConfig> {
  const stored = await chrome.storage.sync.get([
    "serverUrl",
    "createMergeRequestOnMerge",
    "tapdBatchSilentMode",
  ]);
  return {
    serverUrl: (stored.serverUrl as string) ?? "",
    createMergeRequestOnMerge: stored.createMergeRequestOnMerge === true,
    tapdBatchSilentMode: stored.tapdBatchSilentMode === true,
  };
}

export async function saveConfig(config: StorageConfig): Promise<void> {
  await chrome.storage.sync.set(config);
}

export function normalizeServerUrl(url: string): string {
  return url.replace(/\/$/, "");
}
