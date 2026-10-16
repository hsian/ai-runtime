import { z } from "zod";
import type { Job } from "../../types.js";

const decisionSchema = z.object({
  action: z.enum(["reply", "needs_input", "implement", "test_cases", "cancel"]),
  message: z.string().min(1).max(20000),
  plan: z.string().max(20000),
});
export const WORKBENCH_DECISION_SCHEMA = {
  type: "object", additionalProperties: false, required: ["action", "message", "plan"],
  properties: {
    action: { type: "string", enum: ["reply", "needs_input", "implement", "test_cases", "cancel"] },
    message: { type: "string" }, plan: { type: "string" },
  },
};
export function parseWorkbenchDecision(output: string) {
  const value = decisionSchema.parse(JSON.parse(output));
  if (value.action === "implement" && !value.plan.trim()) throw new Error("执行计划为空，已停止自动执行");
  return value;
}
export type WorkbenchDecision = ReturnType<typeof parseWorkbenchDecision>;

export function parseWorkbenchReleaseTarget(text: string): string | undefined {
  const match = /^(?:请|帮我|请帮我)?\s*(?:将|把)?\s*(?:(?:本次|这次|当前|这个)(?:的)?(?:修改|改动|代码|提交))?\s*(?:合并|同步|发布)\s*(?:(?:本次|这次|当前|这个)(?:的)?(?:修改|改动|代码|提交))?\s*(?:到|至)\s*[`"']?([a-zA-Z0-9][a-zA-Z0-9_./-]*)[`"']?\s*(?:分支)?[。！!\s]*$/.exec(text.trim());
  return match?.[1];
}

export const isWorkbenchCancellation = (text: string) => /^(?:请)?(?:取消|撤销)(?:这次|本次|当前|这个|本)?(?:任务|执行|任务执行)(?:吧)?[。！!\s]*$/.test(text.trim());
export const isWorkbenchResetRequest = (text: string) => /^(?:请)?(?:(?:取消|撤销)(?:这次|本次|当前|这个|本)?(?:处理|任务|执行|任务执行)?[，,；;\s]*)?(?:将|把|改|让)?(?:这个|当前|本次)?(?:任务|状态)?(?:改为|改成|设为|设置为|回到|退回|恢复到|恢复为)(?:未开始)(?:状态)?[吧。！!\s]*$/.test(text.trim());

export function buildWorkbenchRequest(job: Job): string {
  const legacyAnswers = (job.clarificationHistory ?? []).map(exchange => [...exchange.answers.map(answer => `${answer.question}：${answer.value}`), exchange.note || ""].filter(Boolean).join("\n")).join("\n\n");
  return `${job.prompt}\n\n【已有方案与补充】\n${job.planSummary || ""}\n${legacyAnswers}\n\n【当前任务的持续对话】\n${(job.workbenchMessages ?? []).slice(job.workbenchContextStartIndex || 0).map(message => `${message.role === "user" ? "用户" : "助手"}：${message.text}`).join("\n\n")}\n\n【当前产出】\n${job.implementationSummary || "暂无代码产出"}`;
}
