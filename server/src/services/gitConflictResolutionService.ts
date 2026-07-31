import { runAgent } from "./agent/index.js";
import type { AgentStreamEvent } from "./agent/types.js";
import { appendJobEvent } from "./jobEvents.js";
import { getJob } from "./jobStore.js";
import type { GitConflictContext, GitConflictResolver } from "./gitService.js";

const CONFLICT_SYSTEM_PROMPT = [
  "你是无人值守的 Git 冲突解决机器人。",
  "当前目录是一次临时集成 worktree，Git 已停在 merge 或 cherry-pick 冲突状态。",
  "只允许解决现有冲突，必须理解原任务、目标分支现有实现和来源改动的意图，保留双方兼容逻辑。",
  "禁止扩大需求范围，禁止创建提交，禁止执行 merge/cherry-pick --continue 或 --abort，禁止 push。",
  "完成后确保所有冲突标记已删除；系统会负责暂存、校验和继续 Git 操作。",
  "禁止向用户提问。无法安全判断时不要猜测，在最终说明中明确失败原因。",
].join("");

function emitAgentEvent(jobId: string, event: AgentStreamEvent): void {
  if (event.type === "agent_text" && event.delta) {
    appendJobEvent(jobId, { type: "agent_text", delta: event.delta });
    return;
  }
  if (event.type === "agent_status" && event.statusText) {
    appendJobEvent(jobId, {
      type: "agent_status",
      statusText: event.statusText,
      text: event.statusText,
    });
    return;
  }
  if (event.type === "agent_tool" && event.toolName) {
    appendJobEvent(jobId, {
      type: "agent_tool",
      toolAction: event.toolAction,
      toolName: event.toolName,
      toolDetail: event.toolDetail,
    });
  }
}

export function createJobConflictResolver(jobId: string): GitConflictResolver {
  return async (context: GitConflictContext): Promise<void> => {
    const job = getJob(jobId);
    if (!job) throw new Error("任务不存在，无法调用 AI 解决冲突");

    const operationText = context.operation === "merge" ? "merge" : "cherry-pick";
    appendJobEvent(jobId, {
      type: "stage",
      phase: "ai_conflict_resolution",
      text: `检测到 ${operationText} 冲突，正在由 AI 分析：${context.files.join(", ")}`,
    });

    const prompt = [
      "请解决当前 Git 集成冲突。",
      "",
      `- 操作：${operationText}`,
      `- 来源：${context.sourceRef}`,
      `- 目标分支：${context.targetBranch}`,
      `- 冲突文件：${context.files.join(", ")}`,
      "",
      "【原始开发任务】",
      job.prompt,
      job.planSummary?.trim() ? `\n【已确认方案】\n${job.planSummary.trim()}` : "",
      "",
      "【处理要求】",
      "1. 先查看 git status、来源改动和目标分支当前代码，再逐个处理冲突文件",
      "2. 结合原始任务保留双方仍然有效的逻辑，不得简单整文件选择 ours 或 theirs",
      "3. 只修改冲突所必需的内容，不处理无关问题",
      "4. 删除全部冲突标记，但不要 commit、continue、abort 或 push",
      "5. 完成后简要说明采用了什么合并逻辑",
    ].filter(Boolean).join("\n");

    await runAgent(
      context.worktreePath,
      prompt,
      job.pageContext,
      (event) => emitAgentEvent(jobId, event),
      {
        mode: "execute",
        jobId,
        systemPrompt: CONFLICT_SYSTEM_PROMPT,
        permissionMode: "acceptEdits",
      }
    );

    appendJobEvent(jobId, {
      type: "stage",
      phase: "ai_conflict_resolution_done",
      text: "AI 已完成冲突处理，正在校验并继续集成...",
    });
  };
}
