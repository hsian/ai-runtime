import type { Job } from "../../types.js";
import type { JobEvent } from "../../services/jobEvents.js";
import { testCaseDownloadUrl } from "../../services/testCases/testCaseDownloadService.js";

export const THINKING = "Thinking...";

export function questionChangeInstructions(job: Pick<Job, "projectId" | "agentProvider">, canModifyCode: boolean): string {
  const context = "这是企业微信对话，没有网页模式选择器。不要提示用户切换到功能修改、编码、Plan 等模式，不要要求打开 Web 页面或重新提交到网页。";
  if (!canModifyCode) return context + "当前用户没有代码修改权限。若其要求实际修改，说明需要联系管理员开通权限；不要让其发送执行命令。";
  const command = [job.agentProvider === "codex" ? "#codex" : "", job.projectId === "yuenongjiao-mini" ? "#小程序" : "",
    "修改：具体需求"].filter(Boolean).join(" ");
  return context + `本次只回答问题，不修改代码。若用户需要实际修改，可提示直接在此对话描述要改什么，或发送「${command}」。系统会先给出计划，用户确认后再执行；不要让用户对当前问答任务直接回复执行。仅分析、解释或讨论方案时不必附加修改提示。`;
}

export function progressStage(job: Job | undefined, phase?: string): string {
  if (job?.jobsAhead && job.jobsAhead > 0) return `正在排队，前面还有 ${job.jobsAhead} 个任务`;
  const stages: Record<string, string> = {
    pull: job?.status === "planning" || job?.taskMode === "question" ? "正在同步项目代码" : "正在准备工作区",
    branch: "正在准备工作区", attachments: "正在准备分析资料",
    plan: "正在分析修改计划", plan_resume: "正在分析修改计划", execute_confirmed: "正在准备工作区",
    question: "正在读取项目代码", agent: "正在分析并修改代码", agent_retry: "正在重试代码修改",
    test_case: "正在分析需求并设计测试用例",
    commit: "正在整理并提交改动", merge: "正在合并改动", release_merge: "正在合并改动",
    default_revert: "正在撤回修改", revert_wait: "正在等待撤回处理",
  };
  if (phase && stages[phase]) return stages[phase];
  if (job?.status === "pending") return "正在等待处理";
  if (job?.status === "planning") return "正在分析修改计划";
  if (job?.taskMode === "question") return "正在分析项目问题";
  if (job?.taskMode === "test-case") return "正在生成测试用例";
  return "正在处理";
}

export function formatProgress(job: Job | undefined, phase?: string): string {
  return progressStage(job, phase);
}

export function latestAgentActivity(events: JobEvent[]): string {
  const stageIndex = events.map(event => event.type === "stage" ? event.phase : undefined)
    .reduce((last, phase, index) => phase ? index : last, -1);
  const phase = events[stageIndex]?.phase;
  if (!["plan", "plan_resume", "agent", "agent_retry", "question", "test_case"].includes(phase ?? "")) return "";
  const current = events.slice(stageIndex + 1).reverse();
  const latest = current.find(event => event.type === "agent_status" || event.type === "agent_tool");
  const tool = current.find(event => event.type === "agent_tool" && event.toolName);
  const labels: Record<string, string> = {
    Read: "读取文件", read_file: "读取文件", Glob: "查找文件", Grep: "搜索代码",
    Edit: "修改文件", Write: "写入文件", MultiEdit: "修改文件",
    Bash: "执行项目命令", command_execution: "执行项目命令", exec_command: "执行项目命令",
  };
  let detail = "";
  if (tool) {
    const name = tool.toolName!.split(".").at(-1)!;
    detail = labels[name] ?? `调用 ${name.replace(/[^a-zA-Z0-9_:-]/g, "").slice(0, 40) || "工具"}`;
    // Display only a file name, never raw shell commands, file contents or arbitrary tool input.
    if (["Read", "read_file", "Edit", "Write", "MultiEdit"].includes(name) && tool.toolDetail) {
      try {
        const input = JSON.parse(tool.toolDetail) as { file_path?: unknown; path?: unknown };
        const path = input?.file_path ?? input?.path;
        if (typeof path === "string") {
          const file = path.replace(/\\/g, "/").split("/").filter(Boolean).slice(-2).join("/");
          detail += `：${file.replace(/[\r\n`<>]/g, "").slice(0, 100)}`;
        }
      } catch { /* Truncated tool input still has a useful tool label. */ }
    }
  }
  if (latest?.type === "agent_status") {
    const status = latest.statusText ?? latest.text ?? "";
    const known = ["正在思考...", "正在请求模型响应...", "正在执行命令..."];
    const statusLabel = known.includes(status) ? status.replace(/\.\.\.$/, "") : "模型处理中";
    return detail ? `${statusLabel}；最近活动：${detail}` : statusLabel;
  }
  return detail;
}

export const HELP = "可以直接聊天、询问项目问题，或告诉我想修改什么。\n"
  + "项目问题只读分析；明确要求修改时先返回计划，回复「执行」后开始修改，合并和预览沿用项目配置。\n"
  + "也可以用「问答：问题」「修改：需求」指定处理方式；「状态」「取消」「新会话」管理当前任务。\n"
  + "「测试用例：需求」生成测试用例 Excel，也可以说「给这个需求生成测试用例」，完成后返回下载链接。\n"
  + "消息开头加「#codex 」仅本次任务使用 Codex，例如「#codex 测试用例：登录校验」；后续新任务仍使用默认引擎。\n"
  + "消息开头加「#小程序 」处理粤农交小程序，不带标识使用默认项目；可组合「#codex #小程序 需求」。小程序任务可用「#小程序 状态」「#小程序 执行」管理，或在命令后附完整任务编号。\n"
  + "不同话题可以穿插提问，追问时可带上页面或功能名称；指代不清时会先询问。\n"
  + "「话题」查看已有话题，「状态 任务编号」回到对应话题。\n"
  + "发送 TAPD 详情链接可读取正文、评论和配图；可以同时说「分析这个需求」或「按需求实现」。\n"
  + "「重新读取需求」更新当前话题的 TAPD 资料，不修改 TAPD 原文或已启动任务的快照。\n"
  + "私聊发送「我的ID」查看机器人收到的个人用户标识。\n"
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
  const engineFooter = job.wecomExplicitEngine && job.agentProvider === "codex"
    ? "\n\n本次回答执行引擎为 codex。" : "";
  if (job.status === "awaiting_confirm") return `${header}\n${job.planSummary ?? job.message}\n\n回复「执行」开始修改，回复「取消」取消任务。` + engineFooter;
  if (job.status === "awaiting_input") {
    const questions = job.clarificationQuestions?.map((q, i) => `${i + 1}. ${q.question}${q.options?.length ? `\n选项：${q.options.join(" / ")}` : ""}`).join("\n\n");
    return `${header}\n${job.message ?? "请补充信息"}\n\n${questions}\n\n请按编号逐行回答。` + engineFooter;
  }
  if (job.revertedFromDefaultAt) return `${header}已使用 Git revert 撤回这次修改。`
    + (job.previewUrl ? `\n预览：${job.previewUrl}` : "");
  if (job.revertError) return `${header}撤回失败：${job.revertError}\n原修改仍未撤回。`;
  if (job.status === "completed" && job.taskMode === "test-case" && job.testCaseDocument) {
    const document = job.testCaseDocument;
    const assessment = document.implementationAssessment;
    const url = testCaseDownloadUrl(job);
    return `${header}已生成「${document.moduleName}」测试用例，共 ${document.cases.length} 条。\n`
      + (assessment ? `实现评估：${assessment.recommendedResult}\n${assessment.summary}\n\n` : "\n")
      + (url ? `[下载 Excel](${url})\n链接有效期 24 小时，过期后发送「状态 ${job.jobId}」获取新链接。`
        : `任务：${job.jobId}`) + engineFooter;
  }
  if (job.status === "completed") return uniqueLinks(`${header}\n${job.implementationSummary || job.message || "任务完成"}`
    + `${job.mergedToDefaultBranch ? `\n\n已合并到：${job.mergedToDefaultBranch}` : ""}`
    + `${job.previewUrl ? `\n预览：${job.previewUrl}` : ""}${job.previewMessage ? `\n${job.previewMessage}` : ""}`).trim() + engineFooter;
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
