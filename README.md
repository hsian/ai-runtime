# AI Runtime

面向公司内网的 AI 代码任务工作台。React Web 提供项目问答、代码修改 Plan、实时执行进度、附件、TAPD、Git 合并和回滚能力；Node.js 服务负责 Claude Code、任务队列、Git worktree 和操作日志。

## 项目结构

```text
web/        React + TypeScript + Ant Design 前端
server/     Express API、Agent、Git、TAPD 和任务队列
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

需要单独调试时，也可以使用 `npm run dev:server` 或 `npm run dev:web`。

浏览器访问 `http://localhost:5173`。开发服务器会把 `/api` 请求代理到 `http://localhost:6080`；可通过 `VITE_API_PROXY` 修改目标地址。

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

## 操作日志

操作日志默认写入 `server/data/logs/operations-YYYY-MM-DD.jsonl`：

- 默认保留 7 天
- 单文件默认 20 MB 后分片
- 每 6 小时清理过期文件
- 不记录完整 Prompt、图片和 Agent 流式输出
- Token 和带密码 URL 会自动脱敏

相关配置参见 `server/.env.example`。
