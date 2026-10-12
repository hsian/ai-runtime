import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { buildCodexWebSocketOverrides, loadCodexWebSocketOverrides } from "./codexWebSocketOverrides.js";

test("official/default CLI configuration never creates a code-switch provider", () => {
  assert.deepEqual(buildCodexWebSocketOverrides(""), []);
  assert.deepEqual(buildCodexWebSocketOverrides('model_provider = "openai"\nmodel = "gpt-5"'), []);
});

test("existing named providers are overridden without depending on provider IDs or TOML formatting", () => {
  assert.deepEqual(buildCodexWebSocketOverrides(`
model_provider = "custom"
[model_providers.custom]
name = 'My provider'
supports_websockets = true
[model_providers."code-switch"]
name = "OpenAI"
supports_websockets = true
`), ["-c", "model_providers.custom.supports_websockets=false", "-c", "model_providers.code-switch.supports_websockets=false"]);
  assert.deepEqual(buildCodexWebSocketOverrides('model_providers = { proxy = { name = "Proxy" } }'),
    ["-c", "model_providers.proxy.supports_websockets=false"]);
});

test("unnamed providers and unsafe CLI key names do not get additional overrides", () => {
  assert.deepEqual(buildCodexWebSocketOverrides(`
[model_providers.incomplete]
supports_websockets = true
[model_providers.empty]
name = " "
[model_providers."unsafe&key"]
name = "Unsafe"
`), []);
});

test("configuration is loaded from the supplied Codex home and reread after changes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-transport-test-"));
  try {
    assert.deepEqual(await loadCodexWebSocketOverrides(directory), []);
    await writeFile(join(directory, "config.toml"), '[model_providers.proxy]\nname = "Proxy"');
    assert.deepEqual(await loadCodexWebSocketOverrides(directory), ["-c", "model_providers.proxy.supports_websockets=false"]);
    await writeFile(join(directory, "config.toml"), 'model_provider = "openai"');
    assert.deepEqual(await loadCodexWebSocketOverrides(directory), []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("installed CLI reproduces the unnamed-provider error and loads the corrected default configuration offline", async t => {
  const execution = { shell: process.platform === "win32", encoding: "utf8" as const, timeout: 10_000, windowsHide: true };
  const version = spawnSync("codex", ["--version"], execution);
  if (version.error || version.status !== 0) { t.skip("Codex CLI is not installed"); return; }
  const directory = await mkdtemp(join(tmpdir(), "codex-config-check-"));
  try {
    await writeFile(join(directory, "config.toml"), 'model_provider = "openai"');
    const env = { ...process.env, CODEX_HOME: directory };
    const before = spawnSync("codex", ["-c", "model_providers.code-switch.supports_websockets=false", "features", "list"],
      { ...execution, env });
    assert.notEqual(before.status, 0);
    assert.match(before.stderr, /provider name must not be empty/);
    const after = spawnSync("codex", [...await loadCodexWebSocketOverrides(directory), "features", "list"], { ...execution, env });
    assert.equal(after.status, 0, after.stderr);
    assert.doesNotMatch(after.stderr, /provider name must not be empty/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
