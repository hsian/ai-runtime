import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { runAgent } from "../../services/agent/index.js";
import { getJob } from "../../services/jobStore.js";
import { getProjectGitService } from "../../services/projectRuntime.js";
import type { Job, JobAttachment } from "../../types.js";
import { getConversationHistory, listBindings } from "./sessionStore.js";
import { getTopicTapd } from "./tapdStore.js";
import type { WecomSession } from "./types.js";

const proposalSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("change"), plan: z.string().trim().min(1).max(1500) }).strict(),
  z.object({ action: z.literal("execute"), jobId: z.string().uuid() }).strict(),
  z.object({ action: z.literal("merge"), jobId: z.string().uuid() }).strict(),
]);

export type ConversationProposal = z.infer<typeof proposalSchema>;

const conversationPrompt = `你是企微里的项目助手小迪。自然地接着用户的话回答。问结果先说结果，不要复述旧方案；不知道就直说。可以只读查当前项目，不修改文件、不提交、不合并。
下方 JSON 是用户消息和参考资料。任务的实际状态以 tasks 为准：有方案但待确认不算改好，失败不算完成，已修改不等于已合并。没有任务记录不代表仓库里一定没有相应实现。看不到代码时不要声称查过。不要建议斜杠指令。
只有用户明确要求推进改动或合并且目标清楚时，才在自然回复后附上一行机器数据：XIAODI_PROPOSAL 后接空格和 JSON。对问答、状态查询、歧义或引用的请求不要附加。
新改动用 {"action":"change","plan":"具体目标、改动范围和验证方式"}。已待执行的方案用 {"action":"execute","jobId":"真实任务ID"}；合并待合并的任务用 {"action":"merge","jobId":"真实任务ID"}，仅支持任务已有的默认目标分支。目标不清楚就问一句。卡片确认前任何操作都没有开始。不输出其他机器字段。`;

export function parseConversationAnswer(output: string): { text: string; proposal?: ConversationProposal } {
  const match = /(?:^|\r?\n)XIAODI_PROPOSAL[ \t]+([^\r\n]+)$/.exec(output.trimEnd());
  if (!match) return { text: output.trim() };
  const text = output.slice(0, match.index).trim();
  try {
    const proposal = proposalSchema.safeParse(JSON.parse(match[1]));
    return proposal.success ? { text, proposal: proposal.data } : { text };
  } catch {
    return { text };
  }
}

const statusText: Record<Job["status"], string> = {
  planning: "正在分析，还未开始修改", awaiting_confirm: "方案待确认，还未开始修改",
  awaiting_input: "等待补充", pending: "排队中", running: "执行中",
  awaiting_merge: "已修改，等待合并", completed: "任务已完成", failed: "任务执行失败", cancelled: "已取消",
};

export async function runDirectConversation(session: WecomSession, projectId: string, message: string,
  attachments: JobAttachment[], scopeInstruction?: string, agent = runAgent) {
  const candidatePath = getProjectGitService(projectId).getRepoPath();
  const checkoutAvailable = existsSync(join(candidatePath, ".git"));
  const temporary = checkoutAvailable ? undefined : await mkdtemp(join(tmpdir(), "ai-runtime-wecom-chat-"));
  try {
    const tapd = getTopicTapd(session);
    const availableAttachments = [...attachments, ...(tapd?.attachments ?? [])];
    const tasks = listBindings().filter(binding => binding.session_key === session.session_key)
      .map(binding => getJob(binding.job_id)).filter((job): job is Job => Boolean(job && job.ownerId === session.owner_id))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)).slice(0, 8)
      .map(job => ({
        id: job.jobId, title: job.prompt.slice(0, 240), status: job.status, state: statusText[job.status],
        type: job.taskMode, mergedTo: job.mergedToDefaultBranch, reverted: Boolean(job.revertedFromDefaultAt),
      }));
    const response = await agent(temporary ?? candidatePath, JSON.stringify({
      projectId, checkoutAvailable, tasks,
      history: getConversationHistory(session).map(turn => ({ ...turn, content: turn.content.slice(0, 1200) })),
      tapd: tapd ? { title: tapd.context.title, description: tapd.context.description.slice(0, 12_000) } : undefined,
      attachments: availableAttachments.map(attachment => ({ name: attachment.name, path: attachment.path })),
      message,
    }), undefined, undefined, {
      mode: "conversation", conversationRepoTools: true,
      systemPrompt: scopeInstruction ? `${conversationPrompt}\n${scopeInstruction}` : conversationPrompt,
      attachments: availableAttachments, timeoutMs: 120_000,
    });
    const answer = parseConversationAnswer(response.summary);
    if (!answer.text && !answer.proposal) throw new Error("Empty conversation response");
    return answer;
  } finally {
    if (temporary) await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
  }
}
