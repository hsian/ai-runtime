/** Exact, standalone social messages only. Never classifies project requests with a model. */
export function chatQuickReply(text: string, channel: "wecom" | "workbench" = "wecom"): string | undefined {
  const normalized = text.trim().replace(/[\s!！?？。.,，~～]/g, "");
  if (/^(你好|您好|嗨|哈喽|hi|hello|hey|在吗|在不在|早上好|晚上好|下午好)$/i.test(normalized)) {
    return "你好，我在。你可以和我聊聊，也可以直接问项目问题或告诉我想改什么。";
  }
  if (/^(谢谢|谢谢你|多谢|感谢|辛苦了|thanks|thankyou)$/i.test(normalized)) return "不客气，有问题随时说。";
  if (/^(你是谁|你能做什么|你会做什么|你有什么功能)$/.test(normalized)) {
    return "我是项目开发助手，可以解释代码、排查问题、生成测试用例 Excel，也可以修改功能。"
      + (channel === "wecom" ? "修改前会先给你计划，等你确认执行。" : "直接描述要改什么；需要补充时我会问你，明确要求修改后再动代码。");
  }
  if (/^(?:你)?(?:能|可以)(?:闲聊|聊天)(?:吗|么)$/.test(normalized)) return "可以。这里主要帮你处理项目问题；直接说要分析或修改什么就行。";
  if (/^(test|测试)$/i.test(normalized)) return "消息收到了，连接正常。";
  return undefined;
}
