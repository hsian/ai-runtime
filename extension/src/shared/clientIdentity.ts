const CLIENT_ID_KEY = "aiRuntimeClientId";
let cachedClientId: string | null = null;

export async function getClientId(): Promise<string> {
  const stored = await chrome.storage.local.get([CLIENT_ID_KEY]);
  const existing = stored[CLIENT_ID_KEY];
  if (typeof existing === "string" && existing.trim()) {
    cachedClientId = existing;
    return existing;
  }

  const clientId = crypto.randomUUID();
  cachedClientId = clientId;
  await chrome.storage.local.set({ [CLIENT_ID_KEY]: clientId });
  return clientId;
}

export function getClientIdSync(): string {
  if (cachedClientId) return cachedClientId;
  cachedClientId = crypto.randomUUID();
  void chrome.storage.local.set({ [CLIENT_ID_KEY]: cachedClientId });
  return cachedClientId;
}

export function withClientId(url: string, clientId: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set("clientId", clientId);
  return parsed.toString();
}
