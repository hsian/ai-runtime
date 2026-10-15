export type Command = ({ action: "execute" | "status" | "cancel" | "merge" | "discard"; jobId?: string }
  | { action: "new" | "help" | "topics" | "identity" }
  | { action: "question" | "plan" | "test-case" | "clarify" | "auto"; text: string; jobId?: string }
  | { action: "revert"; jobId?: string }
  | { action: "release"; targetBranch: string; jobId?: string }
  | { action: "chat"; reply: string; historySource?: "task" }) & { topicId?: string; topicTitle?: string; agentProvider?: "claude" | "codex"; projectId?: string };

export function requiresTextConfirmation(command: Command): boolean {
  return ["execute", "cancel", "merge", "discard", "revert", "release"].includes(command.action);
}

export function parseTaskPrefixes(raw: string): { text: string; agentProvider?: "codex"; projectId?: string } {
  let text = raw.trim();
  let agentProvider: "codex" | undefined;
  let projectId: string | undefined;
  let prefix: RegExpExecArray | null;
  while ((prefix = /^#(codex|小程序)(?=\s|[:：]|$)\s*[:：]?\s*/i.exec(text))) {
    if (prefix[1].toLowerCase() === "codex") agentProvider = "codex";
    else projectId = "yuenongjiao-mini";
    text = text.slice(prefix[0].length).trim();
  }
  return { text, ...(agentProvider ? { agentProvider } : {}), ...(projectId ? { projectId } : {}) };
}

export function parseCommand(raw: string): Command {
  const { text, agentProvider, projectId } = parseTaskPrefixes(raw);
  if ((agentProvider || projectId) && !text) return { action: "chat", reply: "请在标识后加上本次任务，例如「#codex 测试用例：登录校验」或「#小程序 问答：登录逻辑」。",
    ...(projectId ? { projectId } : {}) };
  const command = parseCommandText(text);
  return { ...command, ...(agentProvider && "text" in command ? { agentProvider } : {}), ...(projectId ? { projectId } : {}) };
}

function parseCommandText(text: string): Command {
  if (/^我的\s*id$/i.test(text)) return { action: "identity" };
  const control = /^(执行|确认执行|状态|进度|取消|合并|重试合并|放弃合并)(?:\s+([a-f0-9-]{36}))?$/.exec(text);
  if (control) {
    const actions = { 执行: "execute", 确认执行: "execute", 状态: "status", 进度: "status", 取消: "cancel",
      合并: "merge", 重试合并: "merge", 放弃合并: "discard" } as const;
    return { action: actions[control[1] as keyof typeof actions], jobId: control[2] };
  }
  if (text === "新会话") return { action: "new" };
  if (text === "帮助") return { action: "help" };
  if (text === "话题" || text === "话题列表") return { action: "topics" };
  const answer = /^补充\s+([a-f0-9-]{36})\s*[:：]\s*([\s\S]+)$/.exec(text);
  if (answer) return { action: "clarify", jobId: answer[1], text: answer[2] };
  const testCase = /^(?:生成)?测试用例\s*[:：]\s*([\s\S]+)$/.exec(text);
  if (testCase) return { action: "test-case", text: testCase[1] };
  const prefix = /^(问答|修改|补充)\s*[:：]\s*([\s\S]+)$/.exec(text);
  if (prefix) return { action: prefix[1] === "问答" ? "question" : prefix[1] === "补充" ? "clarify" : "plan", text: prefix[2] };
  return { action: "auto", text };
}
