export type Command = ({ action: "execute" | "status" | "cancel" | "merge" | "discard"; jobId?: string }
  | { action: "new" | "help" | "topics" | "identity" }
  | { action: "question" | "plan" | "clarify" | "auto"; text: string; jobId?: string }
  | { action: "revert"; jobId?: string }
  | { action: "chat"; reply: string }) & { topicId?: string; topicTitle?: string };

export function requiresTextConfirmation(command: Command): boolean {
  return ["execute", "cancel", "merge", "discard", "revert"].includes(command.action);
}

export function parseCommand(raw: string): Command {
  const text = raw.trim();
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
  const prefix = /^(问答|修改|补充)\s*[:：]\s*([\s\S]+)$/.exec(text);
  if (prefix) return { action: prefix[1] === "问答" ? "question" : prefix[1] === "补充" ? "clarify" : "plan", text: prefix[2] };
  return { action: "auto", text };
}
