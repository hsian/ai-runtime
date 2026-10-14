# Enterprise WeChat integration

## Workbench clarification inbox (小迪)

Private workbench commands bypass model intent routing. Send `-help` (or `-heip`)
for the complete command list. Main workflow: `-use`, `-use P1`, `-use I2`,
`-list`, `-analyze T1`, `-start T1`, `-reply T1 补充内容`, `-review T1`, `-done T1`.
`-use iter` lists iterations, `-use next` pages them, and `-use 前端` searches
names. `-list next` pages tasks; `-list 关键词` searches assigned tasks.
Number mappings persist per bot/account and never retarget after reordering.
Task ownership is read back from TAPD for every operation.

`-analyze` and its follow-up replies cannot execute code, even if the model
returns an implementation decision. `-start` explicitly enables code changes;
existing tasks keep their engine, conversation and worktree. Review provides a
summary and workbench link (configure `QWECHAT_WORKBENCH_URL` for the full Diff).
`-done` returns a ten-minute confirmation code tied to the exact commit; the
confirmation is consumed before merging, and changed commits require a new one.
Code execution and completion require the existing code allowlist. Backend
readiness is informational, not an execution gate.

Project and iteration selection persist in `workbench_preferences` by login
account. Web selection is written to that store; saved scope is used when the
Web URL does not explicitly select another scope. No new polling is added.

Workbench notices reuse `TAPD_COMPLETION_NOTIFY_RECIPIENTS`: match the logged-in
account's display name or TAPD owner name to the configured real WeCom sender ID.
This works even when TAPD completion notifications are disabled. Conflicting name
matches, or multiple enabled accounts resolving to the same WeCom ID, block both
notifications and replies. Disabled or unmatched accounts cannot receive or submit
clarifications. Use private-chat `我的ID` to obtain the ID.

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

When requirement analysis needs information, 小迪 sends a private notice with the
question and full job ID. Send `待补充` to list your pending workbench questions,
or `补充 完整任务编号：答案` to answer a specific question. A plain text answer is
accepted when exactly one workbench question is pending and its notice has
been delivered. Multiple pending questions require an explicit job ID.
Replies enter the original durable workbench conversation and continue the
same workspace. Review and completion stay in the workbench. Voice and image
supplements currently require text or uploading the image in the workbench.

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

Messages are routed by intent: greetings reply immediately without creating
jobs; other natural-language messages use the configured Agent to distinguish
conversation, read-only project questions, change requests and clarification
answers. Unclear requests ask a short follow-up instead of creating a plan.
One model call understands the latest goal and selects relevant context together.
It receives up to 12 topic candidates with bounded user-goal/TAPD summaries and
two recent user messages per candidate, plus scoped conversation history. It never
receives pending plan bodies, task statuses or historical task-result replies.
Independent goals start a clean topic; linked TAPD references and option choices
stay bound to their source topic. Ambiguous references ask a specific follow-up.
It runs in a temporary directory, with no Git preparation,
Claude tools disabled and Codex in read-only mode with execution tools disabled.
Each classification call times out after 45 seconds. Invalid JSON/schema output
is repaired once from the original input; transport failures are not retried.
Failed classification creates no task and is excluded from conversation memory.
Only explicit control commands can authorize execution; model output cannot
produce execute/cancel/merge actions, and task ownership/confirmation checks remain
in the program rather than the model.
Explicit control commands and `问答：` / `修改：` / `补充：` bypass classification.
`node server/scripts/verify-wecom-intent.mjs` checks classification against
three synthetic messages using the configured Agent; it creates no project jobs
and sends no WeChat messages.
Add `--topics` to check interleaved topic selection and ambiguous references;
this creates synthetic completed records only in an isolated temporary database.
`--tapd` checks analysis versus implementation of a synthetic linked requirement,
without contacting TAPD or creating real jobs.
Only a change request generates a plan. Reply `执行` to execute that plan.
Execution uses the existing project `autoMerge` setting, including automatic
merge into `test` and the existing preview service for `b2b-composite`.
`问答：...` runs the shared read-only project question workflow.
Both Agent providers use WeCom-specific question guidance in their system and
user prompts: changes are requested directly in chat, never through a Web mode
selector. Suggested explicit commands retain the task's project/engine prefix.
Read-only members are directed to an administrator for code-change permission.

Start a message with `#codex ` to use Codex only for the task it creates, such as
`#codex 问答：登录逻辑` or `#codex https://www.tapd.cn/123/stories/view/456 生成测试用例`.
The prefix is removed before intent classification, which uses the default
engine. No session preference is saved: later new tasks use `AGENT_PROVIDER`.
A task retains its engine through clarification and execution. Prefixes on
control commands do not change an existing task's engine or permissions.

Start a message with `#小程序 ` to target the configured `yuenongjiao-mini`
project for that message. Combine it with `#codex ` in either order. Unmarked
new requests use the bot's default project; no project preference is saved.
Project sessions isolate topics, TAPD snapshots, history and active jobs.
Use `#小程序 补充：...`, `#小程序 执行` or `#小程序 状态` to continue or manage
a mini-program task. Commands with a full owned job ID automatically locate its
project when no project prefix is supplied, retaining session binding checks.

`测试用例：...` (or `生成测试用例：...`) runs the shared Web test-case workflow
without code-writing permission or execution confirmation. Natural-language
requests such as `给这个需求生成测试用例` are also classified as `test-case`.
The selected topic's TAPD snapshot and images are copied into the job. Requests
to implement automated test code still use the code-change workflow.
Completion replies include the case count, implementation assessment and Excel
download link. Links reuse the existing preview hostname and the server `PORT`;
without a configured hostname, the existing LAN address detection is used.
No separate download URL configuration is required. Download credentials grant
access only to that task's workbook, expire after 24 hours and require no Web
login. `状态 任务编号` returns a fresh link. Keep the cookie signing secret stable
across restarts.
Explicit `问答：` / `修改：` messages without a TAPD link start a fresh topic. Natural-language
follow-ups select an existing topic semantically. Unknown topic IDs are rejected;
ambiguous references ask the user to name the page or feature instead of guessing.
`状态`, `取消`, `新会话`, and `帮助` manage the current session.
For clarification, answer numbered questions on separate lines (`1. ...`,
`2. ...`); a single question accepts an unnumbered answer. `补充：...` is optional.
After merge failures, `重试合并` and `放弃合并` use existing merge services.
Control commands accept a complete job UUID after a space.
When several tasks can accept a command, a bare command never chooses one.
Use `执行 <job-id>`, `取消 <job-id>`, or `补充 <job-id>：<answers>`.
`状态 <job-id>` selects the task's topic. `新会话` archives previous topic
candidates (without deleting local history) after all unfinished tasks are handled.
`话题` lists recent topics and their task IDs; unique actionable tasks can still
use bare control commands even after switching to another completed topic.

Session scope is bot + chat + sender + project. Each member can control only
their own tasks in that session. Bot visibility is configured in WeChat.
Website browser identities are separate; this module does not bypass website
authentication or provide a website account binding.

SQLite stores message deduplication, sessions, job bindings, and an outbound
notification queue. Significant results are recovered after reconnect/restart.
Interrupted jobs use the server's existing startup behavior and are not replayed.
Notifications are acknowledged per chunk; a lost acknowledgement or a crash
between delivery and persistence can cause a repeated notification, but not a
repeated job submission. Transient progress is throttled to one update per job
per 30 seconds. Images, files, voice and interactive cards are not implemented.

## TAPD links

Send one TAPD story/task/bug detail link, optionally with a question or change
request. Bare links read and associate the material, then ask whether to analyze
or implement; the material itself never authorizes a plan or execution.
Direct image and mixed text/image messages are downloaded and decrypted with
the SDK's per-image key, validated as JPEG/PNG/WebP/GIF, and copied into the same
job attachments as TAPD images. Send screenshots and the request together;
`#codex` and `#小程序` in the text retain their single-task behavior. Image-only
messages use read-only analysis. Failed images stop submission rather than
silently submitting text alone. A message accepts up to nine images and 20 MiB
total, with a 10 MiB per-image limit independent of Web uploads. Download errors
log only the stage, host and safe error codes, never signed URLs or image keys.
File/video messages are not supported.

`tapdBridge.ts` reads the body, comments and available inline images using the
shared `resolveContext.ts` and existing TAPD client. No editing or TAPD writeback
is performed. `tapdStore.ts` persists snapshots per member/topic and identifies
items by workspace, type and ID. Repeated links restore and refresh that topic.
Natural-language follow-ups reuse its saved context. `重新读取需求` explicitly
refreshes the selected topic; existing tasks retain independent body/image copies.

Only workspaces configured in `TAPD_WORKSPACE_ID` / `TAPD_WORKSPACES` can be read
by this bot. This is a configured workspace allowlist, not individual TAPD SSO.
Inline images use trusted HTTPS TAPD/Tencent storage hosts, including redirect
validation; arbitrary external/internal image URLs are not downloaded. At most
20 source images and 20 MiB total are retained, with a 90-second image-loop
budget (each attempted image may finish after that budget). Missing images,
failed comments and truncated bodies are explicitly marked. Successful images
are renumbered with their matching body references before passing to the Agent.
The saved body is bounded to 30,000 characters; chat shows only a short excerpt.

`intentRouter.ts` handles intent classification and immediate social replies.
SQLite also keeps bounded chat history, scoped to each member and conversation.
`topicStore.ts` persists independent topics and their active/last job references.
Each topic retains six recent chat exchanges; selected project tasks reuse the
existing conversation-history builder, which excludes other topics' results.
Topic snapshots are bounded excerpts, not model-generated summaries of all history.
Completed topics remain available for interleaved follow-ups after restart.
Project questions can be asked while a plan awaits confirmation, without
replacing that pending plan. Old greeting-only drafts are retired when a new
real request is submitted.
`jobActions.ts` contains shared plan, question, clarification, execution and
cancellation logic. `jobBridge.ts` adapts commands to those services.
`client.ts` is the only module importing the SDK at runtime. Secrets and full
protocol frames are excluded from SDK logs.

Validation: `npm run build -w server` and
`node --import tsx --test server/src/modules/wecom/*.test.ts`.
After building, `node server/scripts/verify-wecom.mjs` authenticates without
sending messages or creating tasks. Stop the regular bot connection first:
the diagnostic connection uses the same bot identity.
