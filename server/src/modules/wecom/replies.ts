import type { Job } from "../../types.js";

export const THINKING = "Thinking...";

export const HELP = "可以直接聊天、询问项目问题，或告诉我想修改什么。\n"
  + "项目问题只读分析；明确要求修改时先返回计划，回复「执行」后开始修改，合并和预览沿用项目配置。\n"
  + "也可以用「问答：问题」「修改：需求」指定处理方式；「状态」「取消」「新会话」管理当前任务。\n"
  + "不同话题可以穿插提问，追问时可带上页面或功能名称；指代不清时会先询问。\n"
  + "「话题」查看已有话题，「状态 任务编号」回到对应话题。\n"
  + "发送 TAPD 详情链接可读取正文、评论和配图；可以同时说「分析这个需求」或「按需求实现」。\n"
  + "「重新读取需求」更新当前话题的 TAPD 资料，不修改 TAPD 原文或已启动任务的快照。\n"
  + "有多个待处理任务时，请用「执行 任务编号」「取消 任务编号」或「补充 任务编号：答案」指定任务。\n"
  + "补充问题按编号逐行回答，例如：\n1. 按钮改为蓝色\n2. 只修改登录页\n"
  + "合并失败后可回复「重试合并」或「放弃合并」。控制命令可附完整任务编号。";

// Proactive Markdown messages have a smaller limit than stream replies.
export function splitMessage(text: string, maxBytes = 3500): string[] {
  const chunks: string[] = [];
  let current = "";
  let bytes = 0;
  for (const char of text) {
    const size = Buffer.byteLength(char, "utf8");
    if (bytes + size > maxBytes && current) { chunks.push(current); current = ""; bytes = 0; }
    current += char;
    bytes += size;
  }
  if (current) chunks.push(current);
  return chunks;
}

export function formatJob(job: Job, details = false): string {
  const header = details ? `**项目：${job.projectId}**\n任务：\`${job.jobId}\`\n` : "";
  if (job.status === "awaiting_confirm") return `${header}\n${job.planSummary ?? job.message}\n\n回复「执行」开始修改，回复「取消」取消任务。`;
  if (job.status === "awaiting_input") {
    const questions = job.clarificationQuestions?.map((q, i) => `${i + 1}. ${q.question}${q.options?.length ? `\n选项：${q.options.join(" / ")}` : ""}`).join("\n\n");
    return `${header}\n${job.message ?? "请补充信息"}\n\n${questions}\n\n请按编号逐行回答。`;
  }
  if (job.revertedFromDefaultAt) return `${header}已使用 Git revert 撤回这次修改。`
    + (job.previewUrl ? `\n预览：${job.previewUrl}` : "");
  if (job.revertError) return `${header}撤回失败：${job.revertError}\n原修改仍未撤回。`;
  if (job.status === "completed") return uniqueLinks(`${header}\n${job.implementationSummary || job.message || "任务完成"}`
    + `${job.mergedToDefaultBranch ? `\n\n已合并到：${job.mergedToDefaultBranch}` : ""}`
    + `${job.previewUrl ? `\n预览：${job.previewUrl}` : ""}${job.previewMessage ? `\n${job.previewMessage}` : ""}`).trim();
  if (job.status === "awaiting_merge") return `${header}\n${job.message ?? "等待合并处理"}\n${job.error ?? ""}\n`
    + (job.mergeRetryable ? "回复「重试合并」重试，或「放弃合并」。" : "回复「合并」再次尝试，或「放弃合并」。");
  if (["pending", "planning", "running"].includes(job.status)) return "仍在处理中，完成后会通知你。";
  return `${header}${job.status === "cancelled" ? "任务已取消" : job.message ?? "处理失败"}${job.error ? `\n${job.error}` : ""}`;
}

export function uniqueLinks(text: string): string {
  const seen = new Set<string>();
  return text.split("\n").map(line => {
    const urls = line.match(/https?:\/\/[^\s<>\])]+/g) ?? [];
    if (urls.length && urls.every(url => seen.has(url.replace(/\/$/, "")))
      && /^(?:预览|预览地址|预览链接)\s*[:：]/.test(line.trim())) return "";
    for (const url of urls) seen.add(url.replace(/\/$/, ""));
    return line;
  }).join("\n").replace(/\n{3,}/g, "\n\n");
}

export function milestoneSignature(job: Job): string | undefined {
  if (!["awaiting_confirm", "awaiting_input", "completed", "failed", "cancelled", "awaiting_merge"].includes(job.status)) return undefined;
  return `${job.status}:${job.clarificationHistory?.length ?? 0}:${job.status === "awaiting_merge" ? job.updatedAt : ""}`
    + (job.revertedFromDefaultAt || job.revertError ? `:${job.revertedFromDefaultAt ?? job.revertError}` : "");
}
