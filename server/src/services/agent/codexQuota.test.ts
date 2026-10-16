import assert from "node:assert/strict";
import { test, after } from "node:test";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexQuotaError, createAutomaticAgent } from "./providerFallback.js";

// Both processes and repositories are local fixtures; never invokes a real CLI.
const root = await mkdtemp(join(tmpdir(), "ai-runtime-quota-test-"));
const script = join(root, "fake.cjs");
const cli = join(root, process.platform === "win32" ? "fake.cmd" : "fake");
await writeFile(script, `
const fs = require('node:fs'); let input = '';
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  const emit = event => console.log(JSON.stringify(event));
  if (input.includes('CASE_STDERR')) { console.error('Your credit balance is too low'); process.exitCode = 1; }
  else if (input.includes('CASE_TOOL')) {
    emit({type:'item.completed',item:{type:'command_execution',command:'check',status:'failed',exit_code:1,aggregated_output:'usage_limit_reached'}});
    emit({type:'item.completed',item:{type:'agent_message',text:'done'}});
  } else if (input.includes('CASE_RECOVERED')) {
    emit({type:'error',message:'temporary network error'});
    emit({type:'turn.completed'});
    emit({type:'item.completed',item:{type:'agent_message',text:'done'}});
  } else if (input.includes('CASE_RATE')) {
    emit({type:'turn.failed',error:{message:'429 Too Many Requests'}});
  } else {
    fs.writeFileSync('partial.txt','existing Codex changes');
    emit({type:'error',message:'You have hit your usage limit.'});
    emit({type:'turn.failed',error:{code:'usage_limit_reached',message:'Please try later'}});
  }
});
`);
await writeFile(cli, process.platform === "win32"
  ? `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`
  : `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, { mode: 0o755 });
Object.assign(process.env, { GIT_ACCESS_TOKEN: "test-only", CODEX_CLI_PATH: cli, CODEX_MODEL: "", CODEX_PROFILE: "",
  CODEX_ENABLE_SYSTEM_PROXY: "false", CODEX_DISABLE_WEBSOCKETS: "false", CODEX_TIMEOUT_MS: "10000" });
const { runCodexAgent } = await import("./codexAgentService.js");
after(() => rm(root, { recursive: true, force: true }));

test("JSON quota errors trigger continuation even with a zero process exit code", async () => {
  let calls = 0;
  const run = createAutomaticAgent(runCodexAgent, async (repo, _prompt, _page, _event, options) => {
    calls++; assert.equal(repo, root); assert.equal(options?.jobId, "quota-test");
    assert.equal(await readFile(join(repo, "partial.txt"), "utf8"), "existing Codex changes");
    return { summary: "continued" };
  });
  assert.deepEqual(await run(root, "CASE_QUOTA", undefined, undefined, { mode: "question", jobId: "quota-test" }), { summary: "continued" });
  assert.equal(calls, 1);
});

test("stderr account exhaustion produces a typed quota error", async () => {
  await assert.rejects(runCodexAgent(root, "CASE_STDERR", undefined, undefined, { mode: "question" }), CodexQuotaError);
});

test("tool quota text and recovered transport errors do not cause fallback", async () => {
  for (const prompt of ["CASE_TOOL", "CASE_RECOVERED"]) {
    assert.deepEqual(await runCodexAgent(root, prompt, undefined, undefined, { mode: "question" }), { summary: "done" });
  }
});

test("a generic 429 turn failure remains an error, even on exit zero", async () => {
  await assert.rejects(runCodexAgent(root, "CASE_RATE", undefined, undefined, { mode: "question" }), error =>
    error instanceof Error && !(error instanceof CodexQuotaError) && /429/.test(error.message));
});
