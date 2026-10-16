import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentAbortedError } from "./errors.js";
import { CodexQuotaError, createAutomaticAgent, isCodexQuotaMessage } from "./providerFallback.js";
import type { AgentStreamEvent } from "./types.js";

test("every call starts with Codex, including legacy Claude preferences", async () => {
  let calls = 0;
  const run = createAutomaticAgent(async (_repo, _prompt, _page, _event, options) => {
    calls++; assert.equal(options?.agentProvider, "codex"); return { summary: "ok" };
  }, async () => { throw new Error("unexpected fallback"); });
  await run("worktree", "task", undefined, undefined, { agentProvider: "claude" });
  await run("worktree", "task");
  assert.equal(calls, 2);
});

test("quota fallback retains worktree, prompt, history, images, permissions and schema; next call retries Codex", async () => {
  const events: AgentStreamEvent[] = [];
  let codexCalls = 0, claudeCalls = 0;
  const options = { jobId: "job", mode: "question" as const, permissionMode: "plan", apiDocAccess: true,
    attachments: [{ path: "image.png", name: "image.png", mime: "image/png" }],
    conversationHistory: [{ role: "user" as const, content: "earlier" }], jsonSchema: { type: "object" } };
  const page = { url: "https://example.test", title: "Example", viewport: { width: 1280, height: 720 } };
  const run = createAutomaticAgent(async () => { codexCalls++; throw new CodexQuotaError("usage_limit_reached"); },
    async (repo, prompt, actualPage, onEvent, actualOptions) => {
      claudeCalls++; assert.equal(repo, "existing/worktree"); assert.ok(prompt.startsWith("original task"));
      assert.match(prompt, /先检查当前工作区/); assert.equal(actualPage, page);
      assert.deepEqual(actualOptions, { ...options, agentProvider: "claude" });
      onEvent?.({ type: "agent_text", delta: "done" }); return { summary: "done" };
    });
  for (let i = 0; i < 2; i++) assert.deepEqual(await run("existing/worktree", "original task", page, e => events.push(e), options), { summary: "done" });
  assert.equal(codexCalls, 2); assert.equal(claudeCalls, 2);
  assert.match(events[0].statusText!, /Codex.*Claude/);
});

test("stops, network/auth/tool errors and generic throttling never start Claude", async () => {
  for (const error of [new AgentAbortedError(), new Error("429 Too Many Requests"), new Error("401 login required"), new Error("timeout")]) {
    const run = createAutomaticAgent(async () => { throw error; }, async () => { throw new Error("unexpected fallback"); });
    await assert.rejects(run("worktree", "task"), actual => actual === error);
  }
});

test("Claude failure is returned once without looping or switching back", async () => {
  const failure = new Error("Claude unavailable"); let calls = 0;
  const run = createAutomaticAgent(async () => { throw new CodexQuotaError("quota"); }, async () => { calls++; throw failure; });
  await assert.rejects(run("worktree", "task"), actual => actual === failure); assert.equal(calls, 1);
});

test("tool-free classifiers preserve their exact prompt and options during fallback", async () => {
  const run = createAutomaticAgent(async () => { throw new CodexQuotaError("quota"); }, async (_repo, prompt, _page, _event, options) => {
    assert.equal(prompt, "classify"); assert.equal(options?.disableTools, true); return { summary: "{}" };
  });
  await run("worktree", "classify", undefined, undefined, { disableTools: true });
});

test("recognizes explicit account exhaustion, not bare 429 or unrelated failures", () => {
  for (const message of ["usage_limit_reached", "You've hit your usage limit. Try again later.", "insufficient_quota", "exceeded your current quota", "Your credit balance is too low", "额度已耗尽"]) assert.equal(isCodexQuotaMessage(message), true, message);
  for (const message of ["429 Too Many Requests", "rate_limit_exceeded", "network timeout", "quota remaining: 50", "failed to read image"]) assert.equal(isCodexQuotaMessage(message), false, message);
});
