# Enterprise WeChat integration

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
The classifier selects a topic before choosing an intent. It receives up to
12 topic candidates with bounded task/result snapshots and two recent exchanges
per candidate, plus up to six exchanges from the currently selected topic.
It runs in a temporary directory, with no Git preparation,
Claude tools disabled and Codex in read-only mode with execution tools disabled.
Classification times out after 45 seconds; failures ask the user to clarify.
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
