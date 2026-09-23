# AI Runtime

面向公司内网的 AI 代码任务工作台。React Web 提供项目问答、代码修改 Plan、执行引擎切换、实时执行进度、附件、TAPD、Git 合并和回滚能力；Node.js 服务负责 Claude Code / Codex CLI、任务队列、Git worktree 和操作日志。

## 项目结构

```text
web/        React + TypeScript + Ant Design 前端
server/     Express API、Agent、Git、TAPD、SQLite 任务存储和任务队列
extension/  旧版 Chrome 插件，仅保留用于迁移对照，不参与默认构建
```

## 本地开发

先复制并填写服务端配置：

```powershell
Copy-Item server/.env.example server/.env
```

安装依赖并同时启动 Web 与服务端：

```powershell
npm install
npm run dev
```

服务端会在监听端口前依次检查 `server/projects.json` 中注册的项目仓库。若托管目录不存在，会从远端克隆并在终端输出统计对象、接收对象、解析增量等进度；所有项目仓库初始化完成后，Web 服务才会启动。任一项目首次克隆失败时，服务端会直接启动失败并输出对应项目的错误，修复网络或凭据后重新启动即可重试。

需要单独调试时，也可以使用 `npm run dev:server` 或 `npm run dev:web`。

浏览器访问 `http://localhost:5173`。开发服务器会把 `/api` 请求代理到 `http://localhost:6080`；可通过 `VITE_API_PROXY` 修改目标地址。

Web 页面支持 Plan 待确认、等待合并、任务完成和执行失败提醒。HTTPS 或 `localhost` 下可通过右上角铃铛开启桌面通知；局域网 IP 的普通 HTTP 下会自动改用浏览器标签标题滚动提醒，仅在页面处于后台时滚动，切回页面后恢复正常标题。

## 多项目与小程序

所有项目统一在 `server/projects.json` 注册，包括原有 composite 和独立小程序仓库。前端新建任务时选择项目，提交后会锁定项目，任务历史和上下文按项目隔离。Agent 使用 AI Runtime 自己管理的仓库副本和 worktree，不直接 reset 开发人员日常使用的 checkout。Git Token 等敏感信息仍只保存在 `server/.env`。如果 HTTPS 仓库使用 IP 地址但证书没有匹配该 IP，可在对应项目配置 `"gitSslVerify": false`，AI Runtime 自动 clone、fetch、pull、push 时会跳过 Git SSL 证书校验。

“粤农交小程序”基于 `demo-version` 自动合并。代码任务完成后，可先生成体验版二维码，确认无误后再上传到微信公众平台的开发版本。需要在微信公众平台下载“小程序代码上传密钥”，并在 `server/.env` 配置密钥文件路径。没有固定公网 IP 时，可以关闭“小程序代码上传”的 IP 白名单。上传后不会自动提交审核或发布。

## 构建与部署

```powershell
npm run build
npm run start -w server
```

默认构建 React Web 和服务端。Express 会从 `web/dist` 同源托管页面，浏览器直接访问：

```text
http://服务器内网IP:6080
```

不需要 Nginx，也不需要单独部署前端。

## 客户端身份

服务端首次访问时签发带 HMAC 签名的 HttpOnly Cookie，作为匿名 `ownerId` 隔离任务。来源内网 IP 只用于操作日志，不用于任务归属，因此 IP 变化或复用不会导致任务串台。

未配置 `CLIENT_COOKIE_SECRET` 时，服务端会自动生成 `server/data/client-cookie-secret`。该文件必须保留，删除后所有浏览器会获得新的匿名身份。

## 填写工时与账号

主工作台继续使用匿名浏览器身份。左侧“更多功能”中的“填写工时”需要账号登录；登录后，账号管理入口只对管理员显示。访问 `/work-hours` 和 `/account-management` 也会在服务端校验会话与权限。

首次部署先在 `server` 目录创建唯一的初始管理员：

```text
npm run auth:create-admin -- zhengweixian 郑伟贤 郑伟贤
```

命令会显示一次性初始密码，首次登录必须修改。之后由管理员在页面创建、停用或重置成员账号。账号绑定的 TAPD 处理人决定该账号能读取和填写谁的任务，不由页面请求指定。账号、会话和工时修改记录保存在 `server/data/ai-runtime.sqlite` 中，请持久化该数据库。当前权限分为管理员与成员；主工作台将来启用登录时可复用此会话和权限中间件。

工时页按完成时间读取已完成任务，按标题估算复杂度并分配目标工时；仅预览时不写 TAPD，确认后才逐条更新。已有“实际工时”或“页面数”的任务会保留原值。不同 TAPD 项目分别查询任务字段配置，缺少目标字段的项目会提示错误。写入部分失败时，成功的任务仍保留，并展示失败结果。

## 任务数据

任务、状态和执行事件默认持久化到 `server/data/ai-runtime.sqlite`。服务重启后历史任务仍可查询；重启时仍处于 `planning`、`pending` 或 `running` 的任务会标记为执行中断，等待确认的 Plan 会继续保留。

服务启动时及之后每 6 小时执行一次统一清理：已完成、失败、取消、等待确认、等待补充信息或等待合并且超过 `JOB_RETENTION_DAYS`（默认 3 天）的任务，会连同执行事件、工作区和附件一起删除。

部署到容器或临时文件系统时，请持久化整个 `server/data` 目录，至少包括：

- `ai-runtime.sqlite`、`ai-runtime.sqlite-wal` 和 `ai-runtime.sqlite-shm`
- `client-cookie-secret`
- `uploads/`

## 操作日志

操作日志默认写入 `server/data/logs/operations-YYYY-MM-DD.jsonl`：

- 默认保留 7 天
- 单文件默认 20 MB 后分片
- 每 6 小时清理过期文件
- 不记录完整 Prompt、图片和 Agent 流式输出
- Token 和带密码 URL 会自动脱敏

## Agent 执行引擎

前端输入框下方可按任务选择 `Claude` 或 `Codex`。服务端默认值由 `server/.env` 的 `AGENT_PROVIDER` 控制：

```env
AGENT_PROVIDER=claude
CODEX_CLI_PATH=codex
CODEX_ENABLE_SYSTEM_PROXY=true
CODEX_DISABLE_WEBSOCKETS=true
```

使用 Codex 前，需要在服务端机器上安装 Codex CLI 并完成登录：

```powershell
codex login
codex doctor
```

相关配置参见 `server/.env.example`。
