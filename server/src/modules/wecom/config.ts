import { z } from "zod";
import { config as runtimeConfig } from "../../config.js";
import { getProject } from "../../services/projectRegistry.js";

export function getWecomConfig() {
  // Import runtime config first so server/.env has already been loaded.
  void runtimeConfig;
  const values = z.object({
    QWECHAT_BOT_ENABLED: z.enum(["true", "false"]).default("false"),
    QWECHAT_BOT_ID: z.string().trim().optional(),
    QWECHAT_BOT_SECRET: z.string().trim().optional(),
    QWECHAT_BOT_DEFAULT_PROJECT: z.string().default("b2b-composite"),
    QWECHAT_BOT_PREVIEW_HOST: z.string().trim().optional(),
    QWECHAT_CODE_ALLOWED_USER_IDS: z.string().default(""),
    TAPD_COMPLETION_NOTIFY_ENABLED: z.enum(["true", "false"]).default("false"),
    TAPD_COMPLETION_NOTIFY_WORKSPACE_IDS: z.string().default(""),
    TAPD_COMPLETION_NOTIFY_RECIPIENTS: z.string().default("{}"),
  }).parse(process.env);
  if (values.QWECHAT_BOT_ENABLED !== "true") return undefined;
  if (!values.QWECHAT_BOT_ID || !values.QWECHAT_BOT_SECRET) {
    throw new Error("启用企微机器人需要 QWECHAT_BOT_ID 和 QWECHAT_BOT_SECRET");
  }
  const project = getProject(values.QWECHAT_BOT_DEFAULT_PROJECT);
  if (values.QWECHAT_BOT_PREVIEW_HOST && !/^[a-zA-Z0-9.\[\]:-]+$/.test(values.QWECHAT_BOT_PREVIEW_HOST)) {
    throw new Error("QWECHAT_BOT_PREVIEW_HOST 应填写主机名或 IP，可带端口，不带协议和路径");
  }
  return { botId: values.QWECHAT_BOT_ID, secret: values.QWECHAT_BOT_SECRET,
    projectId: project.id, previewHost: values.QWECHAT_BOT_PREVIEW_HOST,
    codeAllowedUserIds: parseCodeAllowedUserIds(values.QWECHAT_CODE_ALLOWED_USER_IDS),
    tapdCompletion: values.TAPD_COMPLETION_NOTIFY_ENABLED === "true" ? parseCompletionOptions(
      values.TAPD_COMPLETION_NOTIFY_WORKSPACE_IDS, values.TAPD_COMPLETION_NOTIFY_RECIPIENTS) : undefined };
}

export interface TapdCompletionOptions {
  workspaceIds: string[];
  recipients: Record<string, string>;
}

export function parseCompletionOptions(workspaces: string, recipients: string): TapdCompletionOptions {
  const workspaceIds = [...new Set(workspaces.split(/[,，\s]+/).filter(Boolean))];
  if (!workspaceIds.length || workspaceIds.some(id => !/^\d+$/.test(id))) {
    throw new Error("完成通知需要配置 TAPD 项目 ID，以逗号分隔");
  }
  const parsed = z.record(z.string().trim().min(1).regex(/^[a-zA-Z0-9._@-]+$/)).parse(JSON.parse(recipients));
  if (!Object.keys(parsed).length || Object.keys(parsed).some(name => !name.trim() || name !== name.trim())) {
    throw new Error("完成通知需要配置 TAPD 处理人姓名与企微用户 ID 的对应关系");
  }
  return { workspaceIds, recipients: parsed };
}

export function parseCodeAllowedUserIds(value: string): string[] {
  const ids = [...new Set(value.split(/[,，\s]+/).filter(Boolean))];
  if (ids.some(id => !/^[a-zA-Z0-9._@-]+$/.test(id))) throw new Error("企微修改白名单应填写真实用户 ID，以逗号分隔，不支持通配符。");
  return ids;
}

export interface WecomConfig {
  botId: string;
  secret: string;
  projectId: string;
  previewHost?: string;
  codeAllowedUserIds?: readonly string[];
  tapdCompletion?: TapdCompletionOptions;
}
