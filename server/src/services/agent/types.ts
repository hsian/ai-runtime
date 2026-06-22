import type { JobAttachment, PageContext } from "../../types.js";

export interface AgentResult {
  summary: string;
}

export interface AgentStreamEvent {
  type: "agent_text" | "agent_tool";
  delta?: string;
  toolAction?: "start" | "done";
  toolName?: string;
  toolDetail?: string;
}

export type AgentEventHandler = (event: AgentStreamEvent) => void;

export const SYSTEM_PROMPT =
  "你是浏览器插件触发的无人值守代码修改机器人。收到任务后必须立即搜索并修改源代码，禁止向用户提问或请求澄清。当前 Git 分支名只是提交用途。根据页面 URL 路由定位前端文件，完成后简要汇报修改内容。";

function extractRoutePath(url?: string): string | undefined {
  if (!url) return undefined;
  try {
    const path = new URL(url).pathname.replace(/^\//, "");
    return path || undefined;
  } catch {
    return undefined;
  }
}

function buildAttachmentSection(attachments?: JobAttachment[]): string {
  if (!attachments?.length) return "";

  const lines = attachments
    .map((file, index) => {
      const n = index + 1;
      return `- 图${n}（配图${n}）: ${file.path}`;
    })
    .join("\n");
  return `
【用户截图 / UI 原型】
用户附带了 ${attachments.length} 张截图，编号与任务描述中的「图N」「配图N」「[配图N]」一致（如图2 = 图2 = 配图2）。
描述里写「如图N」时，必须先 Read 下方对应编号的文件，再分析该段需求：
${lines}

看图规则（违反视为错误实现）：
1. 弹窗/抽屉/表单只实现对应截图里出现的字段与布局，不要把列表页整表搬进弹窗
2. 禁止增加截图未出现的列、按钮、模块
3. 文字描述与截图冲突时，以截图为准
不要向用户追问截图是否上传或文件在哪个目录。`;
}

export function buildClaudeTaskPrompt(
  prompt: string,
  pageContext?: PageContext,
  attachments?: JobAttachment[],
  confirmedPlan?: string
): string {
  const routePath = extractRoutePath(pageContext?.url);

  const contextPart = pageContext
    ? `
【页面信息】
- 访问地址: ${pageContext.url}
- 浏览器标题: ${pageContext.title}
${routePath ? `- 路由路径: /${routePath}（请优先搜索与此路径相关的页面、路由、组件文件）` : ""}
${pageContext.selectedText ? `- 用户选中文字: ${pageContext.selectedText}` : ""}
${pageContext.selectedSelector ? `- 用户选中元素: ${pageContext.selectedSelector}` : ""}`
    : "";

  const attachmentPart = buildAttachmentSection(attachments);

  const planPart = confirmedPlan?.trim()
    ? `
【已确认方案】
${confirmedPlan.trim()}

请严格按以上方案修改代码；若方案与用户原始描述冲突，以方案为准。
`
    : "";

  return `【代码修改任务 - Claude Code 执行阶段】

Plan 已确认，请按方案在 Git 工作区内直接修改源代码。
${planPart}
${contextPart}${attachmentPart}

【开发任务】
${prompt}

【执行要求】
1. 无人值守，禁止向用户提问
2. 根据页面 URL/路由定位文件，用 Edit 工具修改源码
3. 完成后 1-2 句话说明改了哪些文件`;
}

export const PLAN_SYSTEM_PROMPT =
  "你是 Claude Code 的 Plan 模式助手，在 Git 工作区内分析代码。只允许阅读、搜索、分析代码，严禁修改、创建或删除任何文件。根据用户描述和当前测试页面 URL 定位相关源码，输出可执行的改动方案。若任务附带截图/UI 原型，必须先 Read 查看图片再写方案；弹窗类需求必须严格按截图字段与布局设计，禁止把列表整表塞进弹窗。严禁编造对话历史。若信息严重不足无法出方案，说明缺什么后停止；否则直接给出完整方案，不要向用户提问或写「告诉我」「如需调整请说」等收尾。";

export function buildClaudePlanPrompt(
  prompt: string,
  pageContext?: PageContext,
  attachments?: JobAttachment[]
): string {
  const routePath = extractRoutePath(pageContext?.url);

  const contextPart = pageContext
    ? `
【页面信息】
- 访问地址: ${pageContext.url}
- 浏览器标题: ${pageContext.title}
${routePath ? `- 路由路径: /${routePath}` : ""}
${pageContext.selectedText ? `- 用户选中文字: ${pageContext.selectedText}` : ""}`
    : "";

  const attachmentPart = buildAttachmentSection(attachments);

  return `【Claude Code Plan - 在 Git 仓库内分析，禁止改代码】

这是编码模式的 Plan 阶段：结合下方需求与当前测试页面，在仓库中定位文件并给出改动方案。
（需求模式的文字整理已完成；此处才需要读代码。）

${contextPart}${attachmentPart}

【开发任务描述】
${prompt}

【输出要求】
1. 只分析并给出改动方案（涉及哪些文件、怎么改），不要执行修改
2. 结合页面 URL/路由在仓库中搜索定位
3. 有截图时按编号 Read（「如图N」= 图N 附件）；先逐张复述各图 UI 字段与按钮，再搜代码；弹窗只列截图中的字段，禁止擅自扩展成完整数据表
4. 需求简单明确时直接给完整方案，不要追问用户
5. 仅在关键信息缺失、无法判断改哪里时才说明缺什么，然后停止
6. 方案可执行时不要写「请确认」「告诉我」「如需调整」等让用户回复的收尾句
7. 必须把完整方案直接输出在回复正文中，不要只写入计划文件或只返回「已写入计划文件」类短提示
8. 用简洁中文输出`;
}

const CLARIFICATION_PATTERNS = [
  /请补充/,
  /我没明白/,
  /没明白/,
  /具体是什么/,
  /你的需求/,
  /请说明/,
  /什么意思/,
  /比如：/,
  /请告诉我/,
  /告诉我/,
  /需要我/,
  /是否要/,
  /还是其他/,
  /如需调整/,
  /请选择/,
  /选哪个/,
  /哪个方案/,
  /备选\s*[A-Za-z]/,
  /请确认/,
  /？\s*$/,
  /\?\s*$/,
];

export function looksLikeClarification(summary: string): boolean {
  return CLARIFICATION_PATTERNS.some((pattern) => pattern.test(summary));
}

export function summarizeToolInput(input: unknown): string | undefined {
  if (input == null) return undefined;
  if (typeof input === "string") {
    return input.length > 120 ? `${input.slice(0, 120)}…` : input;
  }
  try {
    const text = JSON.stringify(input);
    return text.length > 120 ? `${text.slice(0, 120)}…` : text;
  } catch {
    return undefined;
  }
}
