# Enterprise WeChat integration

## 小迪：直接对话

普通文字、语音转写和图片直接交给配置的 Agent 做一轮只读对话。企微不再运行独立意图识别，
也不再接收工作台斜杠命令、任务控制口令或问答/修改前缀。普通回答保留 Agent 原文，
状态问题参考实际任务记录，不自动附上已有方案。会话、任务和最近几轮上下文按机器人、聊天、发送人和项目隔离。

会话从 `server/projects.json` 选择仓库目录和默认分支，复用运行时的托管仓库初始化；已位于默认分支的有效检出不为每条消息重新拉取。仓库准备失败时明确报告，不在空目录里查代码。
小迪始终只处理工作相关请求：同一轮 Agent 对话结合上下文判断，不设开关，不增加分类调用。
独立招呼礼貌接一句；带工作内容的消息和工作追问正常处理，明确无关的闲聊不展开。
工作台的任务列表、补充和审查仍在 Web。

执行以及需要人工确认的合并通过企微按钮确认。只有在获准成员本人点击后，服务端才核对任务、状态及目标，
再交给现有任务服务。执行确认只能使用一次、十分钟有效，服务重启后卡片失效；任务版本变化须重新确认。
点「取消」可撤销尚未开始的确认，或停止这张卡启动、仍在排队或执行且未进入提交与合并阶段的任务。不会取消其他任务，也不会撤回已提交或合并的代码。
执行成功后按项目配置决定是否自动合并到默认分支；村财默认自动合并到 `test`。未确认的普通消息不会执行代码或合并。
当前任务已合到默认分支后，直接说「合并到 20261116 分支」即可。不用重复任务名，也不会偷偷选更早的任务。确认卡绑定源提交和目标分支，确认后才检查远端分支并执行；不会创建分支或重跑代码任务。
方案与确认卡保留不变；确认后尝试在卡片下方开启一条独立的进度消息，此后只在该消息中刷新。若进度窗口不可用或已失效，只另发最终结果。结果标题取自本次任务，不使用旧话题标题，不附预览地址。

## Workbench notifications

Workbench notices reuse `TAPD_COMPLETION_NOTIFY_RECIPIENTS`: match the logged-in
account's display name or TAPD owner name to the configured real WeCom sender ID.
This works even when TAPD completion notifications are disabled. Conflicting name
matches, or multiple enabled accounts resolving to the same WeCom ID, block both
notifications and replies. Disabled or unmatched accounts cannot receive or submit
clarifications. Configure the actual WeCom sender IDs in the environment.

```dotenv
TAPD_COMPLETION_NOTIFY_RECIPIENTS={"姓名":"wecom-userid"}
# Optional explicit username override, taking precedence over name matching:
QWECHAT_WORKBENCH_RECIPIENTS={}
QWECHAT_WORKBENCH_URL=https://ai.example.com/workbench
QWECHAT_CODE_ALLOWED_USER_IDS=wecom-userid
```

The URL and explicit username mapping are optional. Workbench jobs
record the authenticated Web account ID on creation; legacy jobs without an
account ID are never inferred from browser cookies, nicknames or TAPD names.
They acquire an account ID only when the logged-in owner explicitly sends a
reply/continuation from the workbench; a recorded different TAPD operator blocks
this adoption. Merely viewing a legacy job never binds it or sends a notice.
This integration does not change the original bot's job ownership or dialogue.

When workbench analysis needs more information, 小迪 sends a private notice
with the question, task ID, and workbench link when configured. Reply in the Web workbench.

Questions raised while modifying code stay in the workbench and do not trigger
小迪 notices. When real code changes are ready for Review, 小迪 sends the owner
a private reminder to view the Diff and complete the task in the workbench.
Review reminders are deduplicated by task and commit; a later revised commit
can produce another reminder. Plans without code changes never trigger Review
notices, and queued reminders are discarded if the task resumes or is completed.

Notices persist in SQLite and resume by message chunk after reconnect/restart.
Every send revalidates the account binding and the current question. Once the
question is answered in the Web UI, pending obsolete notices are discarded;
repeated explicit replies report that the question has already been handled.
No production WeCom messages are sent by the automated tests.

## TAPD backend completion notifications

The optional monitor polls TAPD every ten minutes during 09:00–19:00 in
Asia/Shanghai (including weekends). Configure these separately from the code
permission whitelist:

```dotenv
TAPD_COMPLETION_NOTIFY_ENABLED=true
TAPD_COMPLETION_NOTIFY_WORKSPACE_IDS=34579999,61733891
TAPD_COMPLETION_NOTIFY_RECIPIENTS={"TAPD姓名":"wecom_userid"}
```

Workspace IDs must already be registered in `TAPD_WORKSPACES`. Only iterations
whose names contain the current year and month in `YYYY年M月` form are monitored;
both date names and names such as `【研发】2026年10月` match. Each new iteration
first establishes a silent baseline. Every cycle re-reads the complete story and
task lists for these iterations and paginates all results. Newly added stories
and tasks are picked up automatically, including new tasks already completed
when they first become visible after the baseline. Their completion timestamp
is not compared with the last polling time. Existing task states survive restarts
and overnight downtime; each observed completion is deduplicated in SQLite.
At a month change, monitoring switches to the new month; previous-month work is
outside the configured scope.

Only task titles starting with `后端` trigger completion notifications. Frontend
tasks must start with `前端`, belong to the same story and a monitored iteration,
and have an owner with an exact entry in the recipient mapping. Owners separated
by semicolons or commas are supported. No name guessing, directory lookup, or
notification to unconfigured users is performed.

Task states and pending messages are stored in SQLite. Successful messages are
marked sent; failed/blocked messages retry in a subsequent daytime cycle. A
queued notice is discarded if the next poll observes the backend reopened,
the task or requirement deleted, or the frontend owner removed. Messages wait
when the latest workspace scan fails, rather than relying on stale assignments.
Read-only integration validation: build the server, then run
`node scripts/verify-tapd-completion.mjs` from `server/`; this checks real TAPD
queries and recipient matches without starting the bot or sending messages. A
backend task reopened and later completed can notify again. As with other
external sends, a crash after delivery but before recording its acknowledgement
can cause a duplicate on retry. Changes that both complete and reopen between
polls are not observable through task snapshots.

Restart the server after configuration changes. Tests use simulated TAPD data
and simulated message delivery; they do not contact or message teammates.

This module uses the official `@wecom/aibot-node-sdk` long connection. Run only
one enabled server process per bot. It starts with the server and shuts down
with it; no public callback endpoint is required.

Configure `server/.env`:

```dotenv
QWECHAT_BOT_ENABLED=true
QWECHAT_BOT_ID=your_bot_id
QWECHAT_BOT_SECRET=your_secret
QWECHAT_BOT_DEFAULT_PROJECT=b2b-composite
# Optional hostname/IP reachable from team devices; no scheme or path.
QWECHAT_BOT_PREVIEW_HOST=192.168.1.10
```

All Web and WeCom agent calls follow the server's `AGENT_PROVIDER` setting.
When omitted or set to `codex`, calls try Codex first. An explicit Codex account quota
exhaustion automatically continues with Claude in the same workspace, retaining
history, attachments and permissions. Network/authentication errors, generic 429
throttling and cancellation do not switch providers. The next call tries Codex
again. Setting `AGENT_PROVIDER=claude` uses Claude directly and never switches
to Codex. Restart the server after changing this setting. The engine-selection
prefix has been removed; request metadata does not override the server setting.

默认使用机器人的项目。需要访问小程序项目时，可以在消息前加 `#小程序`，这只选择项目，不会触发任务操作。
测试用例 Excel、TAPD 工作台任务管理继续使用 Web。

Session scope is bot + chat + sender + project. Each member can control only
their own tasks in that session. Bot visibility is configured in WeChat.
Website browser identities are separate; this module does not bypass website
authentication or provide a website account binding.

SQLite stores message deduplication, sessions, job bindings, and an outbound
notification queue. Significant results are recovered after reconnect/restart.
Interrupted jobs use the server's existing startup behavior and are not replayed.
Notifications are acknowledged per chunk; a lost acknowledgement or a crash
between delivery and persistence can cause a repeated notification, but not a
repeated job submission.

## TAPD links

Send one TAPD story/task/bug detail link, optionally with a question or change
request. Bare links read and associate the material, then ask whether to analyze
or implement; the material itself never authorizes a plan or execution.
Direct image and mixed text/image messages are downloaded and decrypted with
the SDK's per-image key and passed to the read-only conversation. A message accepts
up to nine images and 20 MiB total, with a 10 MiB per-image limit independent of Web
uploads. File/video messages are not supported.

`tapdBridge.ts` reads the body, comments and available inline images using the
shared `resolveContext.ts` and existing TAPD client. No editing or TAPD writeback
is performed. `tapdStore.ts` persists snapshots per member/topic and identifies
items by workspace, type and ID. Repeated links restore and refresh that topic.
Natural-language follow-ups reuse its saved context. Send the detail link again
to refresh it. A TAPD link alone cannot authorize execution.

Only workspaces configured in `TAPD_WORKSPACE_ID` / `TAPD_WORKSPACES` can be read
by this bot. This is a configured workspace allowlist, not individual TAPD SSO.
Inline images use trusted HTTPS TAPD/Tencent storage hosts, including redirect
validation; arbitrary external/internal image URLs are not downloaded. At most
20 source images and 20 MiB total are retained, with a 90-second image-loop
budget (each attempted image may finish after that budget). Missing images,
failed comments and truncated bodies are explicitly marked. Successful images
are renumbered with their matching body references before passing to the Agent.
The saved body is bounded to 30,000 characters; chat shows only a short excerpt.

`directConversation.ts` assembles a small context and runs a single read-only Agent
turn. Codex loads the service account's usual CLI configuration, including the
server-provided `CODEX_MODEL` and `CODEX_PROFILE` when set. The conversation still
forces the read-only sandbox and never requests elevated approvals.
`conversationActions.ts` validates the separate confirmation events before calling
the shared task execution and merge services.

Validation: `npm run build -w server` and
`node --import tsx --test server/src/modules/wecom/*.test.ts`.
After building, `node server/scripts/verify-wecom.mjs` authenticates without
sending messages or creating tasks. Stop the regular bot connection first:
the diagnostic connection uses the same bot identity.
