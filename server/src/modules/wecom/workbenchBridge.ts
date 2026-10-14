import { createHash } from "node:crypto";
import { getDatabase } from "../../services/database.js";
import { getJob, listJobs } from "../../services/jobStore.js";
import { receiveWorkbenchMessage } from "../../services/workbenchSession.js";
import type { Job } from "../../types.js";
import type { WecomConfig } from "./config.js";
import { canModifyCode } from "./permissions.js";
import { splitMessage } from "./replies.js";
import { parseCommand } from "./commands.js";
import { quickReply } from "./intentRouter.js";
import { createWorkbenchCommands } from "./workbenchCommands.js";

interface Account { id: string; username: string; display_name: string; tapd_owner_name: string }
interface Notice { id: number; job_id: string; signature: string; target_id: string; chunks: string; sent_chunks: number }

export function initWorkbenchBridgeStore(): void {
  getDatabase().exec(`CREATE TABLE IF NOT EXISTS wecom_workbench_notices (
    id INTEGER PRIMARY KEY AUTOINCREMENT, bot_id TEXT NOT NULL,
    job_id TEXT NOT NULL REFERENCES jobs(job_id) ON DELETE CASCADE,
    signature TEXT NOT NULL, target_id TEXT NOT NULL, chunks TEXT NOT NULL,
    sent_chunks INTEGER NOT NULL DEFAULT 0, delivered INTEGER NOT NULL DEFAULT 0,
    UNIQUE(bot_id, job_id, signature, target_id)
  );`);
}

export function workbenchNeedsSupplement(job: Job): boolean {
  return Boolean(job.workbenchSession && job.workbenchUserId && !job.workbenchReset && !job.workbenchPauseRequested
    && job.status === "awaiting_input" && job.workbenchNeedsInput === true && job.workbenchInputSource !== "implementation");
}

function reviewSignature(job: Job): string | undefined {
  if (job.workbenchSession && job.workbenchUserId && !job.workbenchReset && !job.workbenchPauseRequested
    && !job.workbenchTurnRunning && job.status === "awaiting_merge" && job.worktreePath && job.commitSha
    && job.commitSha !== job.workbenchBaseCommitSha && job.workbenchHasCodeChanges !== false) return `review:${job.commitSha}`;
}

function question(job: Job): string {
  return job.workbenchQuestion || job.workbenchMessages?.filter(message => message.role === "assistant").at(-1)?.text
    || job.clarificationQuestions?.map(item => item.question).join("\n") || "请在工作台查看需要补充的问题。";
}

export function workbenchQuestionSignature(job: Job): string {
  return createHash("sha256").update(JSON.stringify([job.workbenchProcessedInputs || 0, question(job)])).digest("hex");
}

function recipient(options: WecomConfig, job: Job): string | undefined {
  if (!job.workbenchUserId) return;
  const account = getDatabase().prepare("SELECT id, username, display_name, tapd_owner_name FROM users WHERE id = ? AND enabled = 1")
    .get(job.workbenchUserId) as Account | undefined;
  const target = account ? targetForAccount(options, account) : undefined;
  return target && accountForSender(options, target)?.id === account?.id ? target : undefined;
}

function targetForAccount(options: WecomConfig, account: Account): string | undefined {
  const explicit = options.workbenchRecipients && Object.hasOwn(options.workbenchRecipients, account.username)
    ? options.workbenchRecipients[account.username] : undefined;
  if (explicit) return explicit;
  const names = options.workbenchNameRecipients || {};
  const targets = [...new Set([account.display_name.trim(), account.tapd_owner_name.trim()]
    .filter(name => Object.hasOwn(names, name)).map(name => names[name]))];
  return targets.length === 1 ? targets[0] : undefined;
}

function accountForSender(options: WecomConfig, sender: string): Account | undefined {
  const accounts = getDatabase().prepare("SELECT id, username, display_name, tapd_owner_name FROM users WHERE enabled = 1")
    .all() as Account[];
  const matches = accounts.filter(account => targetForAccount(options, account) === sender);
  return matches.length === 1 ? matches[0] : undefined;
}

export function createWorkbenchBridge(options: WecomConfig, send: (target: string, text: string) => Promise<unknown>,
  ready: (target: string) => boolean = () => true, receive = receiveWorkbenchMessage) {
  initWorkbenchBridgeStore();
  let stopped = false;
  let flushing = false;
  const retryAfter = new Map<string, number>();
  const title = (job: Job) => (job.prompt.split("\n")[0].replace(/^请分析并实现：\s*/, "") || job.tapdContext?.title || "工作台任务").slice(0, 160);
  const link = (job: Job) => {
    if (!options.workbenchUrl) return "";
    const url = new URL(options.workbenchUrl);
    url.searchParams.set("jobId", job.jobId);
    return `\n[打开任务工作台](${url.href})`;
  };
  const pendingFor = (account: Account) => listJobs().filter(job => job.workbenchUserId === account.id && workbenchNeedsSupplement(job));
  const list = (jobs: Job[]) => "工作台待补充任务：\n\n" + jobs.map(job => `**${title(job)}**\n编号：\`${job.jobId}\`\n${question(job)}${link(job)}`).join("\n\n")
    + "\n\n请发送「补充 完整任务编号：答案」。";
  const fixedCommands = createWorkbenchCommands(options, sender => accountForSender(options, sender), receive);
  return {
    stop() { stopped = true; },
    reconcile() {
      if (stopped) return;
      for (const job of listJobs()) {
        const review = reviewSignature(job);
        if (!workbenchNeedsSupplement(job) && !review) continue;
        const target = recipient(options, job);
        if (!target || accountForSender(options, target)?.id !== job.workbenchUserId) continue;
        const text = review
          ? `**代码已完成，请进行 Review**\n${title(job)}\n任务编号：\`${job.jobId}\`\n\n请到任务工作台查看代码 Diff。需要调整可继续对话；审查通过后点击「完成」合并代码。${link(job)}`
          : `**任务需要你补充信息**\n${title(job)}\n任务编号：\`${job.jobId}\`\n\n${question(job)}${link(job)}\n\n可在工作台回复，也可私聊小迪发送「补充 ${job.jobId}：答案」。只有一个待补充任务时，可直接回复答案。`;
        getDatabase().prepare(`INSERT OR IGNORE INTO wecom_workbench_notices
          (bot_id, job_id, signature, target_id, chunks) VALUES (?, ?, ?, ?, ?)`)
          .run(options.botId, job.jobId, review || workbenchQuestionSignature(job), target, JSON.stringify(splitMessage(text)));
      }
    },
    async flush() {
      if (stopped || flushing) return;
      flushing = true;
      try {
        const notices = getDatabase().prepare("SELECT * FROM wecom_workbench_notices WHERE bot_id = ? AND delivered = 0 ORDER BY id LIMIT 100")
          .all(options.botId) as Notice[];
        for (const notice of notices) {
          const valid = () => {
            const job = getJob(notice.job_id);
            return job && recipient(options, job) === notice.target_id
              && accountForSender(options, notice.target_id)?.id === job.workbenchUserId
              && (notice.signature.startsWith("review:") ? reviewSignature(job) === notice.signature
                : workbenchNeedsSupplement(job) && workbenchQuestionSignature(job) === notice.signature);
          };
          if (!valid()) {
            getDatabase().prepare("UPDATE wecom_workbench_notices SET delivered = 1 WHERE id = ?").run(notice.id);
            continue;
          }
          if (!ready(notice.target_id) || Date.now() < (retryAfter.get(notice.target_id) || 0)) continue;
          try {
            const chunks = JSON.parse(notice.chunks) as string[];
            for (let i = notice.sent_chunks; i < chunks.length; i++) {
              if (stopped || !ready(notice.target_id) || !valid()) break;
              await send(notice.target_id, chunks[i]);
              getDatabase().prepare("UPDATE wecom_workbench_notices SET sent_chunks = ?, delivered = ? WHERE id = ?")
                .run(i + 1, Number(i + 1 === chunks.length), notice.id);
            }
            retryAfter.delete(notice.target_id);
          } catch {
            retryAfter.set(notice.target_id, Date.now() + 15000);
            console.warn("[WeCom] 工作台待补充通知发送失败，将重试");
          }
        }
      } catch { console.warn("[WeCom] 工作台通知队列读取失败，将稍后重试"); }
      finally { flushing = false; }
    },
    async reply(sender: string, content: string, context: { group?: boolean; voice?: boolean; images?: boolean } = {}): Promise<string | undefined> {
      if (stopped) return;
      const fixed = await fixedCommands(sender, content, context);
      if (fixed !== undefined) return fixed;
      const command = parseCommand(content);
      const listRequested = /^(?:工作台)?待补充(?:任务)?$/.test(content.trim());
      const explicit = command.action === "clarify";
      const namedJob = explicit && command.jobId ? getJob(command.jobId) : undefined;
      // Keep the original bot's own task replies in its original handler.
      if (explicit && command.jobId && namedJob && !namedJob.workbenchSession) return;
      const account = accountForSender(options, sender);
      if (context.group) return listRequested || (explicit && namedJob?.workbenchSession) ? "请私聊小迪处理工作台任务补充。" : undefined;
      if (!account) return listRequested || (explicit && namedJob?.workbenchSession) ? "你的企微身份尚未绑定有效的工作台账号，请联系管理员配置。" : undefined;
      const pending = pendingFor(account);
      if (listRequested) return pending.length ? list(pending) : "当前没有工作台待补充任务。";
      if (explicit && !command.jobId && !pending.length) return;
      const plain = command.action === "auto" && !quickReply(command.text) && !/https?:\/\//.test(content);
      if (!explicit && (!plain || !pending.length)) return;
      if (plain || (explicit && !command.jobId)) {
        const sessions = getDatabase().prepare("SELECT active_job_id FROM wecom_sessions WHERE owner_id = ? AND target_id = ?")
          .all(`wecom:${options.botId}:${sender}`, sender) as { active_job_id: string | null }[];
        if (sessions.some(session => {
          const active = session.active_job_id ? getJob(session.active_job_id) : undefined;
          return active && !["completed", "failed", "cancelled"].includes(active.status);
        })) return `你还有企微会话任务，请用完整任务编号指定工作台补充。\n\n${list(pending)}`;
      }
      if (explicit && command.jobId && (!namedJob || namedJob.workbenchUserId !== account.id || recipient(options, namedJob) !== sender)) return "任务不存在或不属于当前绑定的工作台账号。";
      const job = explicit && command.jobId ? namedJob : pending.length === 1 ? pending[0] : undefined;
      if (!job) return pending.length ? `有多个待补充任务，请指定任务编号。\n\n${list(pending)}` : "当前没有工作台待补充任务。";
      if (!workbenchNeedsSupplement(job)) return "该任务当前已不需要补充，可能已从工作台回复。请查看工作台进度。";
      if (!explicit) {
        const delivered = getDatabase().prepare(`SELECT 1 FROM wecom_workbench_notices
          WHERE bot_id = ? AND job_id = ? AND signature = ? AND target_id = ? AND delivered = 1 AND sent_chunks > 0`)
          .get(options.botId, job.jobId, workbenchQuestionSignature(job), sender);
        if (!delivered) return;
      }
      if (!canModifyCode(options, sender)) return "该账号尚未开通企微代码执行权限，补充后会继续修改代码，请联系管理员开通，或到工作台补充。";
      if (context.voice || context.images) return "补充后会继续执行，请使用文字回复；图片请在工作台上传。";
      const answer = explicit ? command.text : content.trim();
      if (!answer.trim()) return "请填写需要补充的答案。";
      // No await between the current question check and consumption. The worker
      // clears needsInput synchronously, so replies from both entry points cannot consume it twice.
      receive(job.jobId, answer);
      return `已将补充写入原任务「${title(job)}」，会继续使用原工作区执行。Review 和完成仍在工作台处理。`;
    },
  };
}
