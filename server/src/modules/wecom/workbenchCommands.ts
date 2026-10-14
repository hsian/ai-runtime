import { randomBytes, randomUUID } from "node:crypto";
import { getTapdConfig } from "../../config.js";
import { getDatabase } from "../../services/database.js";
import { createJob, getJob, listJobs, updateJob } from "../../services/jobStore.js";
import { getProjectGitService } from "../../services/projectRuntime.js";
import type { GitCommitDiff } from "../../services/gitService.js";
import { confirmJobMerge } from "../../services/jobMergeService.js";
import { jobQueue } from "../../services/jobQueue.js";
import { getWorkbenchPreferences, setWorkbenchPreferences } from "../../services/workbenchPreferences.js";
import { receiveWorkbenchMessage } from "../../services/workbenchSession.js";
import { syncWorkbenchTask } from "../../services/tapd/taskStatusSync.js";
import { getTask, getBug, getIterationWorkItems, listIterationBugs, listIterations, loadBackendDependencies } from "../../services/tapd/tapdClient.js";
import { copyJobAttachments, deleteJobAttachments } from "../../services/uploadService.js";
import { loadTapdSnapshot } from "./tapdBridge.js";
import { canModifyCode } from "./permissions.js";
import type { WecomConfig } from "./config.js";
import type { Job } from "../../types.js";

export const WORKBENCH_COMMAND_HELP = `工作台固定命令（私聊使用）：
-use                 查看项目，显示当前选择
-use P1              选项目并列出迭代
-use I2              选迭代，按账号记住
-use iter            直接查看当前项目的迭代
-use next            查看下一页迭代
-use 前端            搜索迭代名称
-list                刷新并列出我的任务及后端状态
-list next           查看下一页任务
-list 关键词         搜索任务
-analyze T1          只分析，不修改代码；补充后仍只分析
-start T1            开始或继续修改代码
-reply T1 补充内容    回复问题，继续原阶段
-review T1           查看修改摘要、验证结果和 Diff 链接
-done T1             获取当前版本的合并确认码
-done T1 确认码      合并该版本并同步 TAPD 已完成
-help                打印本帮助

P/I/T 编号绑定真实条目，不会因翻页变成其他任务。项目和迭代与工作台按账号共用。
后端状态仅供参考，由你判断何时 start。参数错误不猜测执行；同一任务沿用原引擎和工作区。`;

interface Account { id: string; username: string; tapd_owner_name: string }
interface Item { workspaceId: string; iterationId?: string; itemId: string; type: "task" | "bug"; title: string; storyId?: string; status?: string }
interface Choice { short_id: number; data: string }
interface PageState { page?: number; search?: string; kind?: string; workspaceId?: string }
const urlFor = (workspace: string, type: string, id: string) => `https://www.tapd.cn/tapd_fe/${workspace}/${type}/detail/${id}`;
const owns = (owner: string | undefined, name: string) => Boolean(name && owner?.split(/[;；,，|]/).some(value => value.trim() === name.trim()));
const ready = (job: Job) => job.status === "awaiting_merge" && !job.workbenchTurnRunning && !job.workbenchPauseRequested && !job.workbenchReset
  && Boolean(job.commitSha && job.branch && job.worktreePath && job.commitSha !== job.workbenchBaseCommitSha && job.workbenchHasCodeChanges !== false);

export function createWorkbenchCommands(options: WecomConfig, accountFor: (sender: string) => Account | undefined,
  receive = receiveWorkbenchMessage, snapshotLoader = loadTapdSnapshot, operations?: {
    diff?: (job: Job) => Promise<GitCommitDiff>; enqueueMerge?: (jobId: string) => void;
  }) {
  const db = getDatabase();
  db.exec(`CREATE TABLE IF NOT EXISTS workbench_command_choices (
    bot_id TEXT NOT NULL, user_id TEXT NOT NULL, kind TEXT NOT NULL, short_id INTEGER NOT NULL, identity TEXT NOT NULL, data TEXT NOT NULL,
    PRIMARY KEY(bot_id,user_id,kind,short_id), UNIQUE(bot_id,user_id,kind,identity));
    CREATE TABLE IF NOT EXISTS workbench_command_pages (bot_id TEXT NOT NULL, user_id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(bot_id,user_id));
    CREATE TABLE IF NOT EXISTS workbench_merge_confirmations (bot_id TEXT NOT NULL, user_id TEXT NOT NULL, job_id TEXT NOT NULL, commit_sha TEXT NOT NULL,
    code TEXT NOT NULL, expires_at INTEGER NOT NULL, PRIMARY KEY(bot_id,user_id,job_id));`);
  const register = (user: string, kind: string, identity: string, value: unknown) => db.transaction(() => {
    const previous = db.prepare("SELECT short_id FROM workbench_command_choices WHERE bot_id=? AND user_id=? AND kind=? AND identity=?")
      .get(options.botId, user, kind, identity) as { short_id: number } | undefined;
    const number = previous?.short_id || (db.prepare("SELECT COALESCE(MAX(short_id),0)+1 AS n FROM workbench_command_choices WHERE bot_id=? AND user_id=? AND kind=?")
      .get(options.botId, user, kind) as { n: number }).n;
    db.prepare("INSERT INTO workbench_command_choices VALUES (?,?,?,?,?,?) ON CONFLICT(bot_id,user_id,kind,identity) DO UPDATE SET data=excluded.data")
      .run(options.botId, user, kind, number, identity, JSON.stringify(value));
    return `${kind}${number}`;
  })();
  const choice = (user: string, label: string): unknown => {
    const match = /^([PIT])(\d+)$/i.exec(label);
    if (!match) return;
    const row = db.prepare("SELECT short_id,data FROM workbench_command_choices WHERE bot_id=? AND user_id=? AND kind=? AND short_id=?")
      .get(options.botId, user, match[1].toUpperCase(), Number(match[2])) as Choice | undefined;
    return row ? JSON.parse(row.data) : undefined;
  };
  const pageState = (user: string): PageState => {
    const row = db.prepare("SELECT data FROM workbench_command_pages WHERE bot_id=? AND user_id=?").get(options.botId, user) as { data: string } | undefined;
    return row ? JSON.parse(row.data) : {};
  };
  const rememberPage = (user: string, state: PageState) => db.prepare("INSERT INTO workbench_command_pages VALUES (?,?,?) ON CONFLICT(bot_id,user_id) DO UPDATE SET data=excluded.data")
    .run(options.botId, user, JSON.stringify(state));
  const link = (job: Job) => {
    if (!options.workbenchUrl) return "\n工作台地址尚未配置，请登录工作台查看同名任务。";
    const url = new URL(options.workbenchUrl); url.searchParams.set("jobId", job.jobId);
    return `\n[打开任务 / 查看完整 Diff](${url.href})`;
  };
  const findJob = (account: Account, item: Item) => listJobs().find(job => job.workbenchSession && job.workbenchUserId === account.id
    && (item.type === "task" ? job.tapdTask?.workspaceId === item.workspaceId && job.tapdTask.taskId === item.itemId
      : job.tapdContext?.workspaceId === item.workspaceId && job.tapdContext?.itemType === "bug" && job.tapdContext.itemId === item.itemId));

  return async (sender: string, text: string, context: { group?: boolean; voice?: boolean; images?: boolean } = {}): Promise<string | undefined> => {
    if (!/^-[a-z]/i.test(text.trim())) return;
    const parsed = /^-(help|use|list|analyze|start|reply|review|done)(?:\s+([\s\S]*))?$/i.exec(text.trim());
    if (!parsed) return "未知工作台命令，请发送 -help 查看全部命令。";
    const command = parsed[1].toLowerCase(), argument = (parsed[2] || "").trim();
    if (command === "help") return argument ? "帮助命令不需要参数。\n" + WORKBENCH_COMMAND_HELP : WORKBENCH_COMMAND_HELP;
    if (context.group) return "请私聊小迪使用工作台命令，避免在群里展示个人任务。";
    if (context.voice || context.images) return "固定命令请用文字发送；图片请在工作台补充。";
    const account = accountFor(sender);
    if (!account) return "企微身份没有唯一对应的有效工作台账号，请检查姓名映射。";
    try {
      const cfg = getTapdConfig();
      const scope = getWorkbenchPreferences(account.id);
      if (command === "use") {
        if (!argument) return `当前项目：${cfg.workspaces.find(item => item.id === scope.workspaceId)?.name || scope.workspaceId || "未选择"}；迭代：${scope.iterationId || "未选择"}\n\n`
          + cfg.workspaces.map(workspace => `${register(account.id, "P", workspace.id, workspace)}  ${workspace.name || workspace.id}`).join("\n") + "\n\n发送 -use P1 选择项目。";
        if (/^P\d+$/i.test(argument)) {
          const workspace = choice(account.id, argument) as { id: string; name?: string } | undefined;
          if (!workspace || !cfg.workspaces.some(item => item.id === workspace.id)) return "项目编号无效，请发送 -use 重新查看。";
          scope.iterationId = scope.workspaceId === workspace.id ? scope.iterationId : undefined;
          scope.workspaceId = workspace.id;
          setWorkbenchPreferences(account.id, scope);
        } else if (/^I\d+$/i.test(argument)) {
          const iteration = choice(account.id, argument) as { id: string; workspaceId: string; name: string } | undefined;
          if (!iteration || iteration.workspaceId !== scope.workspaceId || !(await listIterations(scope.workspaceId)).some(item => item.id === iteration.id)) return "迭代编号无效或属于其他项目，请发送 -use iter 重新查看。";
          scope.iterationId = iteration.id; setWorkbenchPreferences(account.id, scope);
          return `已选择：${cfg.workspaces.find(item => item.id === scope.workspaceId)?.name || scope.workspaceId} / ${iteration.name}\n之后直接发送 -list。`;
        }
        if (!scope.workspaceId || !cfg.workspaces.some(item => item.id === scope.workspaceId)) return "请先发送 -use 选择项目。";
        const previous = pageState(account.id);
        const next = argument === "next";
        if (next && (previous.kind !== "I" || previous.workspaceId !== scope.workspaceId)) return "请先发送 -use iter 查看迭代。";
        const search = next ? previous.search || "" : /^P\d+$/i.test(argument) || argument === "iter" ? "" : argument;
        const iterations = (await listIterations(scope.workspaceId)).filter(item => !search || item.name.includes(search));
        const page = next ? (previous.page || 0) + 1 : 0;
        const visible = iterations.slice(page * 10, page * 10 + 10);
        if (!visible.length) return next ? "已经是最后一页。发送 -use iter 回到第一页。" : "没有匹配迭代。可发送 -use iter 查看全部。";
        rememberPage(account.id, { kind: "I", workspaceId: scope.workspaceId, search, page });
        return visible.map(item => `${register(account.id, "I", `${scope.workspaceId}/${item.id}`, { ...item, workspaceId: scope.workspaceId })}  ${item.name}`).join("\n")
          + `\n\n第 ${page + 1} 页；发送 -use I编号 选择${iterations.length > (page + 1) * 10 ? "，-use next 下一页" : ""}。`;
      }
      if (command === "list") {
        if (!scope.workspaceId || !scope.iterationId || !cfg.workspaces.some(workspace => workspace.id === scope.workspaceId)) return "请先发送 -use 选择项目和迭代。";
        const [items, bugs] = await Promise.all([getIterationWorkItems(scope.iterationId, scope.workspaceId), listIterationBugs(scope.iterationId, { workspaceId: scope.workspaceId })]);
        let dependencies: Awaited<ReturnType<typeof loadBackendDependencies>> | undefined;
        try { dependencies = await loadBackendDependencies(items); } catch { /* Report unknown, never pretend ready. */ }
        const rows: Item[] = [
          ...items.stories.flatMap(story => story.tasks.filter(task => owns(task.owner, account.tapd_owner_name)).map(task => ({ workspaceId: scope.workspaceId!, iterationId: scope.iterationId, itemId: task.id, title: task.name, type: "task" as const, status: task.status, storyId: story.id }))),
          ...items.orphanTasks.filter(task => owns(task.owner, account.tapd_owner_name)).map(task => ({ workspaceId: scope.workspaceId!, iterationId: scope.iterationId, itemId: task.id, title: task.name, type: "task" as const, status: task.status, storyId: task.story_id })),
          ...bugs.filter(bug => owns(bug.current_owner || bug.owner, account.tapd_owner_name)).map(bug => ({ workspaceId: scope.workspaceId!, iterationId: scope.iterationId, itemId: bug.id, title: bug.title || bug.name || bug.id, type: "bug" as const, status: bug.status })),
        ];
        const previous = pageState(account.id), next = argument === "next";
        if (next && (previous.kind !== "T" || previous.workspaceId !== scope.workspaceId)) return "请先发送 -list 查看任务。";
        const search = next ? previous.search || "" : argument;
        const filtered = rows.filter(item => !(item.type === "task" ? /^(done|completed|已完成)$/i : /^(done|completed|closed|verified|已完成|已关闭|已验证)$/i).test(item.status || "")
          && (!search || item.title.includes(search)));
        const page = next ? (previous.page || 0) + 1 : 0;
        const visible = filtered.slice(page * 15, page * 15 + 15);
        if (!visible.length) return next ? "已经是最后一页。" : "当前范围没有匹配的未完成任务。";
        rememberPage(account.id, { kind: "T", workspaceId: scope.workspaceId, search, page });
        return visible.map(item => {
          const label = register(account.id, "T", `${item.workspaceId}/${item.type}/${item.itemId}`, item);
          const backend = dependencies?.[item.itemId] || [];
          const done = backend.filter(task => task.status === "done").length;
          const hint = item.type === "bug" ? "Bug" : !dependencies ? "后端状态读取失败" : !backend.length ? "无后端任务 / 依赖待确认" : `${done === backend.length ? "后端已就绪" : "等待后端"} ${done}/${backend.length}`;
          return `${label}  ${item.title}\n${item.status === "done" ? "已完成" : item.status === "progressing" ? "进行中" : item.status || "未开始"} · ${hint}`;
        }).join("\n\n") + `\n\n第 ${page + 1} 页。${filtered.length > (page + 1) * 15 ? "-list next 下一页。" : ""}\n-analyze T编号 只分析；-start T编号 开始修改。`;
      }
      const match = /^(T\d+)(?:\s+([\s\S]*))?$/i.exec(argument);
      if (!match || ((command === "analyze" || command === "start" || command === "review") && match[2]) || (command === "reply" && !match[2]?.trim())) return `用法：-${command} T编号${command === "reply" ? " 补充内容" : command === "done" ? " [确认码]" : ""}。任务编号从 -list 获取。`;
      const item = choice(account.id, match[1]) as Item | undefined;
      if (!item || !cfg.workspaces.some(workspace => workspace.id === item.workspaceId)) return "任务编号无效，请发送 -list 查看自己的任务。";
      const current = item.type === "task" ? await getTask(item.itemId, item.workspaceId) : await getBug(item.itemId, item.workspaceId);
      const currentOwner = current && "current_owner" in current ? current.current_owner || current.owner : current?.owner;
      let job = findJob(account, item);
      const completedBugRetry = command === "done" && item.type === "bug" && job?.mergedToDefaultAt && job.tapdSync?.target === "resolved";
      if (!current || (!owns(currentOwner, account.tapd_owner_name) && !completedBugRetry)) return "该任务已删除或负责人已变化，不能操作，请刷新 -list。";
      if (command === "review") {
        if (!job) return "这个任务还没有工作台执行记录，可先 -analyze 或 -start。";
        if (!ready(job)) return `该任务尚未准备好 Review。${job.message || ""}${link(job)}`;
        const diff = operations?.diff ? await operations.diff(job) : await getProjectGitService(job.projectId).getCommitDiff(job.commitSha!, undefined, job.workbenchBaseCommitSha);
        return `${item.title}\n\n${job.implementationSummary || "代码已准备好。"}\n\n${diff.files.length} 个文件，新增 ${diff.additions} 行，删除 ${diff.deletions} 行。\n版本：${job.commitSha!.slice(0, 12)}${link(job)}\n审查后发送 -done ${match[1].toUpperCase()}。`;
      }
      if (current.status === "done" || current.status === "closed") return "该条目在 TAPD 已完成，请刷新 -list；不会重复修改或合并。";
      if ((command === "start" || command === "done" || (command === "reply" && !job?.workbenchAnalysisOnly)) && !canModifyCode(options, sender)) return "该企微账号尚未开通代码执行权限，请到工作台处理或联系管理员配置。";
      if (command === "done") {
        if (!job) return "还没有执行记录，不能完成。";
        if (job.mergedToDefaultAt) {
          await syncWorkbenchTask(job.jobId, "done");
          const sync = getJob(job.jobId)?.tapdSync;
          return sync?.state === "failed" ? `代码已合并，TAPD 同步失败：${sync.error || "请到工作台重试"}${link(job)}` : item.type === "bug" ? "代码已合并，Bug 已解决并转回创建人，等待测试回归。" : "代码已合并，TAPD 状态已同步。";
        }
        if (!ready(job)) return "当前没有可合并的实际代码版本，请先 -review 查看进度。";
        const confirmation = db.prepare("SELECT commit_sha,code,expires_at FROM workbench_merge_confirmations WHERE bot_id=? AND user_id=? AND job_id=?")
          .get(options.botId, account.id, job.jobId) as { commit_sha: string; code: string; expires_at: number } | undefined;
        if (!match[2]) {
          const code = randomBytes(3).toString("hex");
          db.prepare("INSERT INTO workbench_merge_confirmations VALUES (?,?,?,?,?,?) ON CONFLICT(bot_id,user_id,job_id) DO UPDATE SET commit_sha=excluded.commit_sha,code=excluded.code,expires_at=excluded.expires_at")
            .run(options.botId, account.id, job.jobId, job.commitSha!, code, Date.now() + 600_000);
          return `将合并「${item.title}」\n版本：${job.commitSha!.slice(0, 12)}\n${item.type === "bug" ? "合并成功后将 Bug 改为已解决，并转回创建人回归。" : "合并成功后同步 TAPD 已完成。"}\n确认请发送：-done ${match[1].toUpperCase()} ${code}\n确认码 10 分钟有效，代码变更后需重新确认。`;
        }
        if (!confirmation || confirmation.code !== match[2].trim() || confirmation.expires_at < Date.now() || confirmation.commit_sha !== job.commitSha) return "确认码无效、已过期或代码已更新。请重新 -review，再发送 -done 获取确认码。";
        db.prepare("DELETE FROM workbench_merge_confirmations WHERE bot_id=? AND user_id=? AND job_id=?").run(options.botId, account.id, job.jobId);
        updateJob(job.jobId, { status: "pending", message: "已从小迪确认合并，等待排队…", mergeRetryable: false });
        if (operations?.enqueueMerge) operations.enqueueMerge(job.jobId);
        else jobQueue.enqueue(job.jobId, async id => { await confirmJobMerge(id); });
        return `已确认当前版本，开始合并。${item.type === "bug" ? "合并成功后将 Bug 改为已解决，并转回创建人回归。" : "TAPD 会在合并成功后同步已完成。"}${link(job)}`;
      }
      if (job?.workbenchTurnRunning || (job && ["running", "pending"].includes(job.status) && !job.workbenchPauseRequested)) return "该任务正在处理，请等本轮结束；需要停止可到工作台操作。";
      if (command === "reply" && !job) return "还没有原会话，请先 -analyze 或 -start。";
      if (!job) {
        const storyId = item.type === "task" && "story_id" in current ? current.story_id : item.storyId;
        if (item.type === "task" && (!storyId || storyId === "0")) return "该任务没有关联需求，请先在 TAPD 关联需求再处理。";
        const snapshot = await snapshotLoader(urlFor(item.workspaceId, item.type === "task" ? "story" : "bug", item.type === "task" ? storyId! : item.itemId));
        try {
          const projectId = "b2b-composite";
          job = createJob({ ownerId: `workbench:${account.id}`, projectId, conversationId: randomUUID(), prompt: `请分析并实现：${item.title}\n所属业务项目：${cfg.workspaces.find(workspace => workspace.id === item.workspaceId)?.name || item.workspaceId}。位于 B2B 管理后台共享 monorepo，请定位对应模块。`, taskMode: "code", agentProvider: "codex", tapdContext: snapshot.context });
          updateJob(job.jobId, { workbenchSession: true, workbenchUserId: account.id, tapdOperator: account.tapd_owner_name, status: "awaiting_input", attachments: snapshot.attachments.length ? copyJobAttachments(job.jobId, snapshot.attachments) : undefined,
            tapdTask: item.type === "task" ? { workspaceId: item.workspaceId, taskId: item.itemId } : undefined });
        } finally { await deleteJobAttachments(snapshot.snapshotId).catch(() => undefined); }
      }
      if (command === "analyze" || command === "start") updateJob(job.jobId, { workbenchAnalysisOnly: command === "analyze" });
      receive(job.jobId, command === "reply" ? `补充信息：${match[2]!.trim()}` : command === "analyze" ? "请仅分析这个需求，检查代码和接口文档，不修改代码。" : "请开始修改代码，按需求和最新补充实现。后端状态由我判断，无需重复确认开始。");
      return `已${command === "analyze" ? "开始只读分析，不修改代码" : command === "reply" ? "补充到原会话，继续原阶段" : "开始处理，分析充分后修改代码"}。${link(job)}`;
    } catch (error) { return `命令未完成：${error instanceof Error ? error.message : "请稍后重试"}`; }
  };
}
