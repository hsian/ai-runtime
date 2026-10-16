import type { Job } from "../../types.js";
import { routeConversation, type IntentModel } from "../conversationIntent.js";
import type { WorkbenchRoutingReply } from "./worker.js";

/** Reuse the bot's tool-free semantic router without importing bot sessions or task dispatch. */
export async function routeWorkbenchConversation(job: Job, model?: IntentModel): Promise<WorkbenchRoutingReply | undefined> {
  const messages = job.workbenchMessages ?? [];
  const pending = messages.filter(message => message.role === "user").slice(job.workbenchProcessedInputs ?? 0);
  // A text-only router cannot classify screenshots. Preserve the existing image flow.
  if (!pending.length || pending.some(message => message.attachmentIndexes?.length)) return undefined;
  const topicId = job.conversationId || job.jobId;
  const result = await routeConversation({
    message: pending.map(message => message.text).join("\n\n"),
    history: messages.slice(0, messages.indexOf(pending[0])).slice(-12).map(message => ({ role: message.role, content: message.text.slice(0, 600) })),
    lastQuestion: job.workbenchQuestion || job.clarificationQuestions,
    linkedTopicId: topicId,
    topics: [{ id: topicId, current: true, title: (job.tapdContext?.title || job.prompt).slice(0, 120),
      userGoal: job.prompt.slice(0, 600),
      tapd: job.tapdContext ? { title: job.tapdContext.title, description: job.tapdContext.description.slice(0, 600) } : undefined }],
    mergeCandidates: [],
  }, model);
  return result.intent === "chat" || result.intent === "uncertain"
    ? { message: result.reply.trim(), needsInput: result.intent === "uncertain" } : undefined;
}
