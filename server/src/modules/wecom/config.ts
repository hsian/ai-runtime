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
    projectId: project.id, previewHost: values.QWECHAT_BOT_PREVIEW_HOST };
}

export interface WecomConfig {
  botId: string;
  secret: string;
  projectId: string;
  previewHost?: string;
}
