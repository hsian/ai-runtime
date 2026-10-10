import type { WecomConfig } from "./config.js";
import type { Command } from "./commands.js";
import type { WecomSession } from "./types.js";
import { getDialogue } from "./dialogueStore.js";
import { getBinding, listBindings } from "./sessionStore.js";
import { getJob } from "../../services/jobStore.js";

export const CODE_PERMISSION_DENIED = "你目前只有问答权限，无法修改代码或执行撤回、合并等操作。请联系管理员开通修改权限。你仍可以询问项目问题或分析 TAPD 需求。";

export function canModifyCode(options: WecomConfig, userId: string): boolean {
  return options.codeAllowedUserIds?.includes(userId) === true;
}

export function requireCommandPermission(session: WecomSession, command: Command, options: WecomConfig): void {
  if (canModifyCode(options, session.user_id)) return;
  if (["plan", "clarify", "execute", "revert", "merge", "discard"].includes(command.action)) {
    throw new Error(CODE_PERMISSION_DENIED);
  }
  if (command.action !== "cancel") return;
  if (command.jobId) {
    // Ownership is checked separately by the bridge; do not inspect another member's job.
    if (getBinding(command.jobId, session.session_key) && getJob(command.jobId)?.taskMode !== "question") {
      throw new Error(CODE_PERMISSION_DENIED);
    }
    return;
  }
  const topicId = command.topicId ?? session.conversation_id;
  const flow = getDialogue({ ...session, conversation_id: topicId });
  if (flow?.step === "revert_confirm" || flow?.step === "reverting") throw new Error(CODE_PERMISSION_DENIED);
  const jobs = listBindings().filter(binding => binding.session_key === session.session_key)
    .map(binding => getJob(binding.job_id));
  if (jobs.some(job => job && job.taskMode !== "question" && job.ownerId === session.owner_id
    && (!command.topicId || job.conversationId === command.topicId)
    && !["completed", "failed", "cancelled"].includes(job.status))) throw new Error(CODE_PERMISSION_DENIED);
}
