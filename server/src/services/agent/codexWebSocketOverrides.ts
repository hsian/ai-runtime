import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse } from "smol-toml";

export function buildCodexWebSocketOverrides(configText: string): string[] {
  const providers = parse(configText).model_providers;
  if (!providers || typeof providers !== "object" || Array.isArray(providers)) return [];
  return Object.entries(providers).flatMap(([id, provider]) => {
    if (!/^[a-zA-Z0-9_-]+$/.test(id) || !provider || typeof provider !== "object" || Array.isArray(provider)) return [];
    const name = (provider as Record<string, unknown>).name;
    // A dotted override for an absent provider creates an invalid, unnamed table.
    return typeof name === "string" && name.trim()
      ? ["-c", `model_providers.${id}.supports_websockets=false`] : [];
  });
}

export async function loadCodexWebSocketOverrides(codexHome = process.env.CODEX_HOME?.trim() || join(homedir(), ".codex")): Promise<string[]> {
  try {
    return buildCodexWebSocketOverrides(await readFile(join(codexHome, "config.toml"), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn("[AI Runtime] 无法读取 Codex provider 配置，保留 CLI 原有传输设置");
    }
    return [];
  }
}
