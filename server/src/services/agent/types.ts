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

  const lines = attachments.map((file, index) => `- 截图 ${index + 1}: ${file.path}`).join("\n");
  return `
【用户截图】
用户附带了 ${attachments.length} 张页面截图，文件已在当前 Git 工作区内，请直接用 Read 工具打开以下绝对路径：
${lines}
不要向用户追问截图是否上传或文件在哪个目录。`;
}

export function buildClaudeTaskPrompt(
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
${routePath ? `- 路由路径: /${routePath}（请优先搜索与此路径相关的页面、路由、组件文件）` : ""}
${pageContext.selectedText ? `- 用户选中文字: ${pageContext.selectedText}` : ""}
${pageContext.selectedSelector ? `- 用户选中元素: ${pageContext.selectedSelector}` : ""}`
    : "";

  const attachmentPart = buildAttachmentSection(attachments);

  return `【代码修改任务 - Claude Code 执行阶段】

Plan 已确认，请按方案在 Git 工作区内直接修改源代码。

${contextPart}${attachmentPart}

【开发任务】
${prompt}

【执行要求】
1. 无人值守，禁止向用户提问
2. 根据页面 URL/路由定位文件，用 Edit 工具修改源码
3. 完成后 1-2 句话说明改了哪些文件`;
}

export const PLAN_SYSTEM_PROMPT =
  "你是 Claude Code 的 Plan 模式助手，在 Git 工作区内分析代码。只允许阅读、搜索、分析代码，严禁修改、创建或删除任何文件。根据用户描述和当前测试页面 URL 定位相关源码，输出可执行的改动方案。严禁编造对话历史。若信息不足，说明需要补充什么后停止，不要无意义探索仓库。";

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
3. 需求简单明确时直接给方案，不要追问
4. 信息不足时说明需要补充什么，然后停止
5. 用简洁中文输出`;
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
  /需要我/,
  /是否要/,
  /还是其他/,
];

export function looksLikeClarification(summary: string): boolean {
  return CLARIFICATION_PATTERNS.some((pattern) => pattern.test(summary));
}

export const REQUIREMENT_ANALYZE_SYSTEM_PROMPT =
  "你是中文需求文案校稿助手。任务只有一个：把 TAPD 原始需求过滤一遍，让文字更通顺、表达更精准。\n" +
  "本步骤与代码仓库完全无关——不读源码、不搜项目、不输出文件路径、不做技术方案。\n" +
  "硬性规则：\n" +
  "1. 禁止 Grep/Glob/WebSearch/WebFetch，禁止调用与配图无关的工具\n" +
  "2. 只润色原文，不扩写、不总结、不重组为需求文档、不补背景、不补验收标准\n" +
  "3. 保留原文的意思、信息量、顺序、页面名、按钮名、字段名、业务词、数字、条件和示例\n" +
  "4. 可以删除明显重复、寒暄、无关外链、乱码和噪音；不确定的内容原样保留\n" +
  "5. 只输出润色后的正文，不要前言、标题、解释或 markdown 代码块\n" +
  "6. 输出必须按自然段编号，每段单独换行，格式为「1. ...」「2. ...」「3. ...」\n" +
  "7. 不要输出「图片」「[图片]」「配图」这类占位词；图片只用于辅助理解原文";

function buildRequirementAttachmentSection(attachments: JobAttachment[]): string {
  if (!attachments.length) return "";

  const lines = attachments.map((file, index) => `- 配图 ${index + 1}: ${file.path}`).join("\n");
  return `
【TAPD 配图】
共 ${attachments.length} 张。必须先用 Read 读取这些图片，结合图片校准原文表达；但输出正文里不要出现「图片」「配图」「如图」等占位说明。
仅允许读取以下文件：
${lines}`;
}

function stripImagePlaceholders(text: string): string {
  return text
    .replace(/\[图片(?::[^\]]*)?\]/g, "")
    .replace(/^\s*(图片|配图)\s*$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function buildRequirementAnalyzePrompt(
  title: string,
  tapdUrl: string,
  rawContent: string,
  attachments: JobAttachment[] = []
): string {
  const attachmentPart = buildRequirementAttachmentSection(attachments);
  const cleanedRawContent = stripImagePlaceholders(rawContent);

  return `【需求原文校稿 - 只润色，不改需求】

把下方 TAPD 原始需求用 AI 过滤一遍：让文字更通顺，表达意思更精准。
仅此而已。不要改写成产品文档，不要重新设计结构，不要分析代码，不要写技术方案。

【需求标题】
${title}

【TAPD 链接（备注）】
${tapdUrl}
${attachmentPart}
【TAPD 原文】
${cleanedRawContent}

【校稿要求】
1. 尽量保持原文段落和表达顺序，只做必要的语句润色
2. 保留所有具体信息，不要用抽象词替换具体描述
3. 不要新增原文没有的信息；不要猜测需求意图
4. 原文含糊的地方可以稍微改顺，但不能改变含义
${attachments.length > 0 ? "5. 必须先读取配图，用配图帮助理解原文；不要额外编造图中没有的需求，也不要在输出里写「图片」「配图」「如图」\n" : ""}6. 直接输出润色后的需求正文
7. 按原文自然段拆分输出，每段用数字编号；每个编号必须单独占一行，编号之间空一行
8. 禁止把多个编号写在同一行，例如禁止输出「1. ...2. ...3. ...」这种粘连格式

正确示例：
1. 第一段润色后的内容

2. 第二段润色后的内容

3. 第三段润色后的内容`;
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
