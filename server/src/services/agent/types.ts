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

  return `【代码修改任务 - 立即执行】

${contextPart}${attachmentPart}

【修改需求】
${prompt}

【执行要求】
1. 这是无人值守自动任务，禁止向用户提问或请求澄清
2. 根据路由/URL 在仓库中定位对应页面文件，找到标题相关代码并修改
3. 使用 Edit 工具直接修改源文件，不要只给建议
4. 完成后用 1-2 句话说明：改了哪些文件、做了什么修改`;
}

export const PLAN_SYSTEM_PROMPT =
  "你是代码分析助手，当前处于 Plan 模式。只允许阅读、搜索、分析代码，严禁修改、创建或删除任何文件。严禁编造对话历史（例如“用户没回答/之前说过”之类）。若用户需求与代码无关（如闲聊）或信息不足，请直接说明“无法判断需要改什么”，并给出你需要的 1-3 个具体问题；不要继续探索仓库、不要假设用户的意图。";

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

  return `【Plan 分析任务 - 只读，禁止改代码】

${contextPart}${attachmentPart}

【用户需求】
${prompt}

【输出要求】
1. 只分析并给出改动方案，不要执行任何修改
2. 严禁编造对话历史（不要写“用户没有回答/未回复”等）
3. 若需求非常简单且明确（例如“页面标题加 123”）：不要追问，直接给出可执行方案（改哪里、怎么改）
4. 若需求与代码无关或信息不足：只输出“需要补充信息”+ 最多 2 个明确问题，然后停止；不要探索仓库
5. 只有在信息足够时，才列出可能涉及的文件路径与修改思路（如有）
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
  "你是产品经理与技术之间的桥梁。根据 TAPD 需求文档原文及附带的需求配图，整理成一份给前端代码修改 AI 使用的中文任务描述（prompt）。只输出最终 prompt 正文，不要加前言、解释或 markdown 代码块围栏。严禁编造文档未提及的功能。若提供了配图文件路径，必须用 Read 工具查看图片内容并纳入分析。忽略外链与无法访问的附件链接。信息不足时在 prompt 末尾用「待确认：」列出需要产品经理补充的点。";

function buildRequirementAttachmentSection(attachments: JobAttachment[]): string {
  if (!attachments.length) return "";

  const lines = attachments.map((file, index) => `- 配图 ${index + 1}: ${file.path}`).join("\n");
  return `
【需求配图】
需求正文含 ${attachments.length} 张配图，已保存为本地文件。请用 Read 工具逐张查看，结合图片理解 UI/流程/验收标准：
${lines}`;
}

export function buildRequirementAnalyzePrompt(
  title: string,
  tapdUrl: string,
  rawContent: string,
  attachments: JobAttachment[] = []
): string {
  const attachmentPart = buildRequirementAttachmentSection(attachments);

  return `【TAPD 需求分析 - 只整理 prompt，禁止改代码、禁止搜索仓库】

【需求标题】
${title}

【TAPD 链接（仅备注，勿访问）】
${tapdUrl}
${attachmentPart}
【需求原文】
${rawContent}

【输出要求】
1. 输出一份可直接用于「根据测试页面修改前端代码」的中文 prompt
2. 提取：要改什么页面/模块、具体 UI/文案/交互、验收标准
3. 若有配图，必须结合配图内容分析，不要忽略
4. 不要编造原文没有的内容
5. 忽略外链与附件下载链接
6. 只输出 prompt 正文，不要标题前缀如「以下是 prompt」`;
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
