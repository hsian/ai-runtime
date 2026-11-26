import assert from "node:assert/strict";
import { test } from "node:test";
import { chatQuickReply } from "./chatQuickReply.js";

test("standalone greetings, thanks, capabilities and chat checks have local replies", () => {
  for (const text of ["你好！", "  Hello? ", "谢谢你", "辛苦了。", "你能做什么？", "你能闲聊吗", "能聊天吗？", "test"]) {
    assert.ok(chatQuickReply(text), text);
    assert.ok(chatQuickReply(text, "workbench"), text);
  }
  assert.doesNotMatch(chatQuickReply("你能做什么", "workbench")!, /确认执行/);
});

test("business requests containing social words and vague confirmations are not swallowed", () => {
  for (const text of ["你好，帮我修改按钮", "测试登录接口", "谢谢，继续修改", "确认", "可以", "继续", "取消", "你好这个变量是什么", "/model", "#小程序 状态", "周末去哪玩"]) {
    assert.equal(chatQuickReply(text), undefined, text);
  }
});
