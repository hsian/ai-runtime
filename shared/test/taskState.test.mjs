import assert from "node:assert/strict";
import { test } from "node:test";
import { getTaskState } from "../dist/taskState.js";

test("analysis and its questions remain not started until implementation begins", () => {
  assert.equal(getTaskState({ status: "planning", workbenchExecutionStarted: false }).boardStatus, "未开始");
  const analysis = getTaskState({ status: "awaiting_input", workbenchNeedsInput: true, workbenchExecutionStarted: false });
  assert.equal(analysis.needsInput, true);
  assert.equal(analysis.workbenchStatus, "未开始 · 待补充");
  assert.equal(analysis.conversationStatus, "等待回复");
  assert.equal(getTaskState({ status: "awaiting_input", workbenchNeedsInput: true, workbenchExecutionStarted: true }).boardStatus, "执行中");
});

test("Review requires actual changes and completion waits for the actor to finish", () => {
  const review = { status: "awaiting_merge", commitSha: "code", workbenchBaseCommitSha: "base" };
  assert.equal(getTaskState(review).canComplete, true);
  assert.equal(getTaskState({ ...review, workbenchTurnRunning: true }).canComplete, false);
  assert.equal(getTaskState({ ...review, commitSha: "base" }).canReview, false);
  assert.equal(getTaskState({ ...review, workbenchHasCodeChanges: false }).boardStatus, "未开始");
});

test("reset, pause and TAPD synchronization have separate state meanings", () => {
  assert.equal(getTaskState({ status: "awaiting_input", workbenchReset: true, commitSha: "old" }).executionStarted, false);
  assert.equal(getTaskState({ status: "awaiting_input", workbenchPauseRequested: true, workbenchExecutionStarted: false }).boardStatus, "未开始");
  assert.equal(getTaskState({ status: "awaiting_input", workbenchPauseRequested: true, workbenchExecutionStarted: true }).boardStatus, "已停止");
  const merged = getTaskState({ status: "completed", mergedToDefaultAt: "today", tapdSync: { target: "resolved", state: "failed" } });
  assert.equal(merged.phase, "completed");
  assert.equal(merged.boardStatus, "待同步");
  assert.equal(merged.canComplete, false);
  assert.equal(merged.conversationStatus, "代码已合并");
});
