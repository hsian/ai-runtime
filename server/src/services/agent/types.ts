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
  agentProvider?: AgentProvider;
  toolAction?: "start" | "done";
  toolName?: string;
  toolDetail?: string;
}

export type AgentEventHandler = (event: AgentStreamEvent) => void;

export interface AgentRunOptions {
  agentProvider?: AgentProvider;
  permissionMode?: string;
  systemPrompt?: string;
  mode?: "plan" | "question" | "execute" | "test-case" | "conversation";
  timeoutMs?: number;
  jobId?: string;
  attachments?: JobAttachment[];
  confirmedPlan?: string;
  conversationHistory?: ConversationHistoryMessage[];
  jsonSchema?: Record<string, unknown>;
  disableTools?: boolean;
  apiDocAccess?: boolean;
  questionChangeInstructions?: string;
}

export const SYSTEM_PROMPT =
  "你是代码修改助手。当前为已确认方案的无人值守执行阶段，按任务范围完成修改。当前任务的工作区、分支、基线、提交与合并由运行时管理。不得自行切换分支、修改工作区基线或执行 checkout、switch、merge、rebase、cherry-pick、push，也不得切换到主仓库进行 Git 操作。用户要求合并或同步到指定分支时，由运行时发版功能处理，不得为此修改源代码或生成替代实现。";

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
      const tapdImageIndex = Number.parseInt(
        /^tapd-description-(\d+)/i.exec(file.name)?.[1] ?? "",
        10
      );
      return Number.isFinite(tapdImageIndex)
        ? `- 附件图${n}（TAPD 配图${tapdImageIndex}）: ${file.path}`
        : `- 附件图${n}（用户手动截图）: ${file.path}`;
    })
    .join("\n");
  return `
【用户截图 / UI 原型】
本次附带了 ${attachments.length} 张图片。TAPD 图片已经按编辑稿中的出现顺序连续编号，文件标注的“配图N”与需求正文完全对应。
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
当前为无人值守执行阶段，按已确认的任务范围修改源码。`;
}

export const PLAN_SYSTEM_PROMPT =
  "你是 Agent 的 Plan 模式助手，在 Git 工作区内分析代码并形成方案。当前阶段只允许阅读、搜索、分析，不得修改、创建或删除文件。信息充分时返回 ready；缺少用户才能决定且阻塞方案的信息时返回 needs_input。";

const DEFAULT_QUESTION_CHANGE_INSTRUCTIONS = "若用户要求实现或调整功能，明确提示必须选择「功能修改」模式后重新提交。";

export function buildQuestionSystemPrompt(changeInstructions = DEFAULT_QUESTION_CHANGE_INSTRUCTIONS): string {
  return "你是项目编程助手。当前为问答阶段，可以阅读、搜索、分析和讨论方案，不得修改、创建或删除文件，不执行代码改动。"
    + changeInstructions;
}

export const QUESTION_SYSTEM_PROMPT = buildQuestionSystemPrompt();

export function buildClaudeQuestionPrompt(
  prompt: string,
  pageContext?: PageContext,
  attachments?: JobAttachment[],
  conversationHistory?: ConversationHistoryMessage[],
  changeInstructions = DEFAULT_QUESTION_CHANGE_INSTRUCTIONS
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

${historyPart}${contextPart}${attachmentPart}

【用户问题】
${prompt}

【流程约束】
当前阶段不执行代码修改。${changeInstructions}`;
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
3. 有截图时按编号查看（「如图N」= 图N 附件）
4. 需求简单明确时直接给完整方案，不要追问用户
5. 当前描述是「改吧」「执行吧」「按这个改」「就这样」等确认语时，结合会话历史采用最近一条尚未执行的用户修改要求作为本次范围
6. 仅当缺少用户才能决定的信息会使方案无法正确或安全地继续时才提问；其余内容自行结合仓库判断
7. 方案确认由运行时处理；可执行时返回 ready，需要用户补充时返回 needs_input
8. 完整方案放在结构化结果的 summary 中，供运行时展示和执行
9. 没有明确要求时，不增加新功能、不改变其他页面、不顺带重构
10. 严格按结构化结果返回：
- 可执行时 result=ready，summary 为方案；questions=[]
- 需要补充时 result=needs_input；questions 最多 2 个
- 每个问题都必须说明 reason；不能阻止正确、安全地形成方案的问题不要输出
- single_choice 问题提供 2-4 个互斥选项，recommendedOption 必须是其中一个；允许自行填写时 allowOther=true
- text 问题的 options=[]、recommendedOption=""、allowOther=false
- 用户已经回答过的问题不得重复询问`;
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
