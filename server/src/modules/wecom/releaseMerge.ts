import { getJob } from "../../services/jobStore.js";
import { getProjectGitService } from "../../services/projectRuntime.js";
import { releaseTaskToBranch } from "../../services/taskOperations.js";
import { getBinding, listBindings } from "./sessionStore.js";
import { canModifyCode, CODE_PERMISSION_DENIED } from "./permissions.js";
import type { Job } from "../../types.js";
import type { WecomSession } from "./types.js";
import type { WecomConfig } from "./config.js";

interface ReleaseOperations {
  branches: (projectId: string) => Promise<string[]>;
  merge: (jobId: string, targetBranch: string) => Promise<void>;
}
const operations: ReleaseOperations = {
  branches: projectId => getProjectGitService(projectId).listRemoteBranches(),
  merge: releaseTaskToBranch,
};

/** Model selects intent only; this boundary owns authorization, scope and Git execution. */
export async function releaseConversationJob(session: WecomSession, command: { jobId?: string; targetBranch: string }, options: WecomConfig, ops = operations): Promise<string> {
  if (!canModifyCode(options, session.user_id)) throw new Error(CODE_PERMISSION_DENIED);
  const candidates = listBindings().filter(binding => binding.session_key === session.session_key)
    .map(binding => getJob(binding.job_id)).filter((job): job is Job => Boolean(job && job.ownerId === session.owner_id
      && job.conversationId === session.conversation_id && job.taskMode === "code" && job.status === "completed"
      && job.mergedToDefaultAt && job.mergedToDefaultBranch && job.branch === job.mergedToDefaultBranch && job.sourceCommitSha && !job.revertedFromDefaultAt));
  const job = command.jobId ? candidates.find(candidate => candidate.jobId === command.jobId) : candidates.length === 1 ? candidates[0] : undefined;
  if (!job || !getBinding(job.jobId, session.session_key)) throw new Error(candidates.length > 1 ? "有多次已完成修改，请明确要合并的任务编号。" : "没有属于当前会话、已完成默认分支合并的代码任务，请先完成代码修改和 Review。");
  const target = command.targetBranch.trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_./-]*$/.test(target)) throw new Error("目标分支名无效，请提供完整分支名。");
  if (target === job.mergedToDefaultBranch) return `本次修改已经合并到 ${target}，无需重复合并。`;
  if (job.releaseMerges?.some(record => record.targetBranch === target && record.status === "completed")) return `本次修改已经合并到 ${target}，无需重复执行。`;
  if (!(await ops.branches(job.projectId)).includes(target)) throw new Error(`远程分支 ${target} 不存在，请核对完整分支名；不会自动新建分支。`);
  await ops.merge(job.jobId, target);
  return `已通过发版合并功能，将「${job.prompt.slice(0, 100)}」的本次提交合并到 ${target}。`;
}
