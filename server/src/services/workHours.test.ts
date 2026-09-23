import assert from "node:assert/strict";
import { test } from "node:test";

import { allocateHours, type WorkTask } from "./tapd/workHours.js";
import { hashPassword, verifyPassword } from "./auth.js";

function task(id: string, name: string, currentHours = ""): WorkTask {
  return { id, name, workspaceId: "1", projectName: "项目", completed: "2026-09-01 10:00:00",
    owner: "郑伟贤;", hoursField: "custom_field_one", pagesField: "custom_field_four",
    currentHours, currentPages: currentHours ? "1" : "", description: "" };
}

test("password hash verifies only the matching password", () => {
  const stored = hashPassword("long-test-password-123");
  assert.equal(verifyPassword("long-test-password-123", stored), true);
  assert.equal(verifyPassword("incorrect-password", stored), false);
  assert.equal(stored.includes("long-test-password-123"), false);
});

test("allocation preserves filled work and keeps task limits", () => {
  const tasks = [task("1", "修改按钮文案", "4"), task("2", "新增复杂报表统计"), task("3", "优化提示")];
  const allocation = allocateHours(tasks, 20);
  assert.equal(allocation.length, 2);
  assert.equal(allocation.reduce((sum, item) => sum + item.hours, 4), 20);
  assert.ok(allocation.every((item) => item.hours >= 1 && item.hours <= 16 && item.pages >= 1));
  assert.ok(allocation[0].hours > allocation[1].hours);
});

test("impossible target is rejected", () => {
  assert.throws(() => allocateHours([task("1", "a")], 17));
});
