import { config } from "../../config.js";
import { buildPromptWithTapdContext } from "../tapd/tapdContext.js";
import { withApiDocContext } from "../apiDocs.js";
import { appendJobEvent } from "../jobEvents.js";
import { getJob, updateJob } from "../jobStore.js";
import { logOperation } from "../operationLog.js";
import { getProject } from "../projectRegistry.js";
import { getProjectGitService } from "../projectRuntime.js";
import { cleanupStagedAttachmentsForAgent, stageAttachmentsForAgent } from "../uploadService.js";
import { AgentAbortedError, runAgent } from "../agent/index.js";
import {
  buildTestCaseBusinessRewritePrompt,
  buildTestCasePrompt,
  TEST_CASE_JSON_SCHEMA,
  TEST_CASE_REWRITE_SYSTEM_PROMPT,
  TEST_CASE_SYSTEM_PROMPT,
} from "./testCasePrompt.js";
import { findTechnicalTokens } from "./testCaseLanguage.js";
import { parseTestCaseDocument } from "./testCaseSchema.js";

export async function runTestCaseJob(jobId: string): Promise<void> {
  const existing = getJob(jobId);
  if (!existing) return;
  const project = getProject(existing.projectId);
  const gitService = getProjectGitService(existing.projectId);
  const startedAt = Date.now();
  const job = updateJob(jobId, {
    taskMode: "test-case",
    status: "running",
    message: `测试用例模式：正在拉取 ${project.defaultBranch} 分支最新代码...`,
  });
  if (!job) return;

  logOperation({
    action: "test_case_generate",
    status: "started",
    jobId,
    ownerId: job.ownerId,
    mode: "test-case",
    engine: job.agentProvider ?? config.AGENT_PROVIDER,
    attachmentCount: job.attachments?.length,
  });

  try {
    appendJobEvent(jobId, { type: "stage", phase: "pull", text: `测试用例模式：正在拉取 ${project.defaultBranch} 分支最新代码...` });
    if (!job.workbenchSession || !job.worktreePath) await gitService.prepareBaseBranch();
    const repoPath = job.workbenchSession && job.worktreePath ? job.worktreePath : gitService.getRepoPath();
    appendJobEvent(jobId, { type: "stage", phase: "test_case", text: "正在分析需求和项目代码并设计测试用例（不会修改代码）..." });
    const stagedAttachments = await stageAttachmentsForAgent(job.attachments, repoPath, jobId);
    const requirement = await withApiDocContext(buildPromptWithTapdContext(job.workbenchLatestPrompt || job.prompt, job.tapdContext));
    const generationPrompt = buildTestCasePrompt({
      requirement,
      pageContext: job.pageContext,
      conversationHistory: job.conversationHistory,
      attachments: stagedAttachments,
    });
    const handleEvent = (event: Parameters<NonNullable<Parameters<typeof runAgent>[3]>>[0]) => {
        if (event.type === "agent_status" && event.statusText) {
          updateJob(jobId, { message: event.statusText });
          appendJobEvent(jobId, { type: "agent_status", statusText: event.statusText, text: event.statusText });
        } else if (event.type === "agent_tool" && event.toolName) {
          appendJobEvent(jobId, {
            type: "agent_tool",
            toolAction: event.toolAction ?? "start",
            toolName: event.toolName,
            toolDetail: event.toolDetail,
            text: event.toolAction === "done" ? `✓ ${event.toolName}` : `▶ ${event.toolName}${event.toolDetail ? `: ${event.toolDetail}` : ""}`,
          });
        }
    };
    const generateOutput = async (prompt: string, options?: { rewrite?: boolean }) => {
      const result = await runAgent(repoPath, prompt, job.pageContext, handleEvent, {
        mode: "test-case",
        systemPrompt: options?.rewrite ? TEST_CASE_REWRITE_SYSTEM_PROMPT : TEST_CASE_SYSTEM_PROMPT,
        jsonSchema: TEST_CASE_JSON_SCHEMA,
        jobId,
        agentProvider: job.agentProvider ?? config.AGENT_PROVIDER,
        apiDocAccess: Boolean(job.workbenchSession && !options?.rewrite),
        attachments: options?.rewrite ? [] : stagedAttachments,
        disableTools: options?.rewrite,
      });
      return result.summary;
    };

    let output = await generateOutput(generationPrompt);
    let document = parseTestCaseDocument(output);
    const technicalTokens = findTechnicalTokens(document);
    const beforeReview = getJob(jobId);
    if (!beforeReview || beforeReview.status === "cancelled" || beforeReview.workbenchPauseRequested) return;
    appendJobEvent(jobId, {
      type: "stage",
      phase: "test_case_rewrite",
      text: "正在复核前置条件、操作步骤、模块命名、UI 标注和优先级，并整理用例分组...",
    });
    output = await generateOutput(buildTestCaseBusinessRewritePrompt(JSON.stringify(document), technicalTokens, requirement), { rewrite: true });
    const reviewedDocument = parseTestCaseDocument(output);
    if (reviewedDocument.cases.length !== document.cases.length) {
      throw new Error("测试用例规范复核改变了用例数量，请重新生成");
    }
    if (reviewedDocument.implementationAssessment && document.implementationAssessment) {
      reviewedDocument.implementationAssessment.recommendedResult = document.implementationAssessment.recommendedResult;
    }
    document = reviewedDocument;

    const current = getJob(jobId);
    if (!current || current.status === "cancelled" || current.workbenchPauseRequested) return;
    const recommendation = document.implementationAssessment?.recommendedResult;
    const message = `已生成 ${document.cases.length} 条测试用例${recommendation ? `，代码分析推荐：${recommendation}` : ""}`;
    updateJob(jobId, { status: "completed", message, testCaseDocument: document });
    appendJobEvent(jobId, { type: "done", phase: "test_case_done", text: message, message });
    logOperation({
      action: "test_case_generate",
      status: "success",
      jobId,
      ownerId: job.ownerId,
      mode: "test-case",
      engine: job.agentProvider ?? config.AGENT_PROVIDER,
      durationMs: Date.now() - startedAt,
      message: `cases:${document.cases.length}`,
    });
  } catch (error) {
    const current = getJob(jobId);
    if (current?.status === "cancelled" || current?.workbenchPauseRequested || error instanceof AgentAbortedError) return;
    const detail = error instanceof Error ? error.message : String(error);
    updateJob(jobId, { status: "failed", error: detail, message: "测试用例生成失败" });
    appendJobEvent(jobId, { type: "error", text: "测试用例生成失败", message: detail });
    logOperation({
      action: "test_case_generate",
      status: "failed",
      jobId,
      ownerId: job.ownerId,
      mode: "test-case",
      engine: job.agentProvider ?? config.AGENT_PROVIDER,
      durationMs: Date.now() - startedAt,
      error: detail,
    });
  } finally {
    await cleanupStagedAttachmentsForAgent(gitService.getRepoPath(), jobId).catch(() => undefined);
  }
}
