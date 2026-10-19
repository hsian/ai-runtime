import assert from "node:assert/strict";
import { test } from "node:test";
import { isBackendTaskName } from "../dist/tapdTask.js";

test("backend names include data-team hyphen prefixes without matching ordinary data features", () => {
  for (const name of ["后端 - 接口", "后端接口", "  数据 - 报表同步  ", "数据-初始化", "数据  - 清洗"]) {
    assert.equal(isBackendTaskName(name), true, name);
  }
  for (const name of ["前端 - 数据展示", "测试 - 数据验证", "数据查询", "数据", "业务数据 - 展示", ""]) {
    assert.equal(isBackendTaskName(name), false, name);
  }
});
