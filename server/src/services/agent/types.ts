import type {
  ConversationHistoryMessage,
  JobAttachment,
  PageContext,
} from "../../types.js";

export interface AgentResult {
  summary: string;
}

export type AgentProvider = "claude" | "codex";

export interface AgentStreamEvent {
  type: "agent_text" | "agent_tool" | "agent_status";
  delta?: string;
  statusText?: string;
  toolAction?: "start" | "done";
  toolName?: string;
  toolDetail?: string;
}

export type AgentEventHandler = (event: AgentStreamEvent) => void;

export interface AgentRunOptions {
  agentProvider?: AgentProvider;
  permissionMode?: string;
  systemPrompt?: string;
  mode?: "plan" | "question" | "execute";
  jobId?: string;
  attachments?: JobAttachment[];
  confirmedPlan?: string;
  conversationHistory?: ConversationHistoryMessage[];
}

export const SYSTEM_PROMPT =
  "你是浏览器插件触发的无人值守代码修改机器人。收到任务后必须立即搜索并修改源代码，禁止向用户提问或请求澄清。当前 Git 分支名只是提交用途。根据用户描述中的页面路径、路由和业务关键词定位前端文件，完成后简要汇报修改内容。";

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
      const tapdSourceIndex = Number.parseInt(
        /^tapd-description-(\d+)/i.exec(file.name)?.[1] ?? "",
        10
      );
      return Number.isFinite(tapdSourceIndex)
        ? `- 附件图${n}（TAPD 原描述配图${tapdSourceIndex}）: ${file.path}`
        : `- 附件图${n}（用户手动截图）: ${file.path}`;
    })
    .join("\n");
  return `
【用户截图 / UI 原型】
本次附带了 ${attachments.length} 张图片。TAPD 图片必须按下方标注的“原描述配图N”与需求文字对应，不能按附件顺序自行重新编号。
描述里提到图片时，必须先 Read 下方准确对应的文件，再分析该段需求：
${lines}

看图规则（违反视为错误实现）：
1. 弹窗/抽屉/表单只实现对应截图里出现的字段与布局，不要把列表页整表搬进弹窗
2. 禁止增加截图未出现的列、按钮、模块
3. 文字描述与截图冲突时，以截图为准
不要向用户追问截图是否上传或文件在哪个目录。`;
}

function buildConversationHistorySection(history?: ConversationHistoryMessage[]): string {
  if (!history?.length) return "";
  const lines = history
    .map((message) => `${message.role === "user" ? "用户" : "助手"}：${message.content}`)
    .join("\n\n");
  return `
【当前手动会话的历史上下文】
以下内容仅用于理解“刚才、这个、前面提到的”等指代，不得据此扩大当前任务范围：
${lines}
`;
}

export function buildClaudeTaskPrompt(
  prompt: string,
  pageContext?: PageContext,
  attachments?: JobAttachment[],
  confirmedPlan?: string,
  conversationHistory?: ConversationHistoryMessage[]
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
  const historyPart = buildConversationHistorySection(conversationHistory);

  const planPart = confirmedPlan?.trim()
    ? `
【已确认方案】
${confirmedPlan.trim()}

这份方案是面向测试/产品人员确认过的业务修改口径，可能不会包含文件名或代码细节。
请把它作为要实现的功能范围和验收标准；真正修改时仍需结合用户原始描述、页面信息、截图以及仓库搜索结果自行定位源码。
若方案与用户原始描述冲突，以方案为准。
`
    : "";

  return `【代码修改任务 - Agent 执行阶段】

Plan 已确认，请按方案在 Git 工作区内直接修改源代码。
${historyPart}${planPart}
${contextPart}${attachmentPart}

【开发任务】
${prompt}

【执行要求】
1. 无人值守，禁止向用户提问
2. 根据用户描述中的页面路径或路由定位文件，用 Edit 工具修改源码
3. 完成后用 1-2 句话总结实际功能、交互或问题修复结果
4. 总结重点说明“改了什么效果”，不要以“已修改 文件路径”开头，不要只罗列文件名`;
}

export const PLAN_SYSTEM_PROMPT =
  "你是 Agent 的 Plan 模式助手，在 Git 工作区内分析代码。只允许阅读、搜索、分析代码，严禁修改、创建或删除任何文件。根据用户描述中的页面路径、路由和业务关键词定位相关源码，但最终输出只是一张给需求提出方确认的简短执行单，不是开发设计文档，也不要复述需求或编写验收说明。重点说明你准备处理什么，以及是否存在容易理解错的边界。禁止出现文件、组件、函数、接口、请求、参数、变量、数据库、状态管理、调用链等技术实现词汇。若任务附带截图/UI 原型，必须先 Read 查看图片，但不要逐图复述，只提取与本次修改直接有关的界面内容。弹窗类需求必须严格按截图字段与布局设计，禁止把列表整表塞进弹窗。严禁编造对话历史。若信息严重不足无法出方案，说明缺什么后停止；否则直接给出完整方案，不要向用户提问或写「告诉我」「如需调整请说」等收尾。";

export const QUESTION_SYSTEM_PROMPT =
  "你是项目代码问答助手。只允许阅读、搜索和分析当前 Git 仓库，严禁修改、创建或删除任何文件，也不要生成修改方案或尝试执行用户描述中的改动。请直接回答用户关于项目实现、接口调用位置、页面结构、样式尺寸、数据流等问题；结论应基于实际代码，必要时给出文件路径和关键位置。若用户要求修改代码，明确提示必须勾选「修改代码」后提交。";

export function buildClaudeQuestionPrompt(
  prompt: string,
  pageContext?: PageContext,
  attachments?: JobAttachment[],
  conversationHistory?: ConversationHistoryMessage[]
): string {
  const routePath = extractRoutePath(pageContext?.url);

  const contextPart = pageContext
    ? `
【当前页面信息】
- 访问地址: ${pageContext.url}
- 浏览器标题: ${pageContext.title}
${routePath ? `- 路由路径: /${routePath}（可优先搜索与此路径相关的页面、路由、组件文件）` : ""}
${pageContext.selectedText ? `- 用户选中文字: ${pageContext.selectedText}` : ""}
${pageContext.selectedSelector ? `- 用户选中元素: ${pageContext.selectedSelector}` : ""}`
    : "";

  const attachmentPart = buildAttachmentSection(attachments);
  const historyPart = buildConversationHistorySection(conversationHistory);

  return `【项目问答 - 只读分析，禁止改代码】

请阅读和搜索当前仓库后直接回答问题。
${historyPart}${contextPart}${attachmentPart}

【用户问题】
${prompt}

【回答要求】
1. 只能读取、搜索和分析，禁止修改、创建或删除文件
2. 基于实际代码回答，不确定时明确说明
3. 可列出相关文件路径、调用关系、样式值或关键代码位置
4. 用户要求修改时不要执行，提示其勾选「修改代码」后重新提交`;
}

export function buildClaudePlanPrompt(
  prompt: string,
  pageContext?: PageContext,
  attachments?: JobAttachment[],
  conversationHistory?: ConversationHistoryMessage[]
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
  const historyPart = buildConversationHistorySection(conversationHistory);

  return `【Agent Plan - 在 Git 仓库内分析，禁止改代码】

这是编码模式的 Plan 阶段：结合下方需求及其中提供的页面路径，在仓库中定位文件并给出改动方案。
（需求模式的文字整理已完成；此处才需要读代码。）

${historyPart}${contextPart}${attachmentPart}

【开发任务描述】
${prompt}

【输出要求】
1. 只分析并给出修改方案，不要执行修改
2. 结合用户描述中的页面路径、路由和业务关键词在仓库中搜索定位
3. 有截图时按编号 Read（「如图N」= 图N 附件），只提取与本次修改有关的字段、按钮和布局，不要复述图片内容；弹窗只包含截图明确展示的内容
4. 需求简单明确时直接给完整方案，不要追问用户
5. 当前描述是「改吧」「执行吧」「按这个改」「就这样」等确认语时，结合会话历史采用最近一条尚未执行的用户修改要求作为本次范围
6. 仅在结合会话历史后仍缺少关键修改目标、无法判断改哪里时，才说明缺什么并停止
7. 方案可执行时不要写「请确认」「告诉我」「如需调整」等让用户回复的收尾句
8. 必须把完整方案直接输出在回复正文中，不要只写入计划文件或只返回「已写入计划文件」类短提示
9. 输出对象完全不懂代码，使用日常用语和短句；不要解释实现原理
10. 禁止出现文件路径、文件名、组件、函数、接口、请求、参数、变量、数据库、状态管理、调用链、代码片段和命令
11. 不照抄或换一种说法复述用户原始描述，只写实际准备处理的内容和必要边界
12. 没有明确要求时，不增加新功能、不改变其他页面、不顺带重构
13. 用下面格式输出：
【本次处理】
- 列出准备执行的修改，最多 3 条，每条使用一句日常用语。
- 简单需求只写 1 条，不要为了凑格式拆分内容。
- 只有存在容易误解的范围时，才补充“保持哪些现有行为不变”。

复杂需求或上下文可能存在歧义时，可在前面增加：
【需求理解】
用一句话说明本次采用的理解；需求明确时省略这一段。

如果信息不足，只输出：
【需要补充】
- 说明缺少的业务信息或页面信息，不要让用户选择技术方案。`;
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
