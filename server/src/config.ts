import "dotenv/config";
import { existsSync } from "fs";
import { resolve } from "path";
import { z } from "zod";

const envSchema = z.object({
  PORT: z.coerce.number().default(3000),
  GIT_REPO_URL: z.string().url(),
  GIT_ACCESS_TOKEN: z.string().min(1),
  GIT_DEFAULT_BRANCH: z.string().default("main"),
  GIT_AUTHOR_NAME: z.string().default("AI Runtime Bot"),
  GIT_AUTHOR_EMAIL: z.string().default("ai-runtime@company.com"),
  WORKSPACE_DIR: z.string().default("./workspace"),
  CLAUDE_CLI_PATH: z.string().default("claude"),
  CLAUDE_MODEL: z.string().optional(),
  CLAUDE_TIMEOUT_MS: z.coerce.number().default(1_200_000),
  CLAUDE_PERMISSION_MODE: z
    .enum(["acceptEdits", "bypassPermissions", "default", "dontAsk", "auto", "plan"])
    .default("acceptEdits"),
  CLAUDE_SKIP_PERMISSIONS: z
    .string()
    .transform((v) => v === "true")
    .default("true"),
  CLAUDE_SETTING_SOURCES: z.string().default("user,project"),
  AUTO_PUSH: z
    .string()
    .transform((v) => v === "true")
    .default("true"),
  /** 是否推送 feature 分支（plugin-fix/*）到远端 */
  PUSH_FEATURE_BRANCH: z
    .string()
    .transform((v) => v === "true")
    // 默认 false：仅 push 默认分支（test）
    .default("false"),
  GIT_SKIP_HOOKS: z
    .string()
    .transform((v) => v === "true")
    .default("true"),
  AUTO_MERGE_TO_DEFAULT_BRANCH: z
    .string()
    .transform((v) => v === "true")
    .default("true"),
  PREVIEW_DEV_ENABLED: z
    .string()
    .transform((v) => v === "true")
    .default("true"),
  CORS_ORIGIN: z.string().default("*"),
  UPLOAD_DIR: z.string().default("./data/uploads"),
  UPLOAD_MAX_BYTES: z.coerce.number().default(300 * 1024),
  /** TAPD 描述配图从远端下载时的体积上限（下载后会由插件压缩再上传） */
  TAPD_IMAGE_MAX_BYTES: z.coerce.number().default(5 * 1024 * 1024),
  UPLOAD_MAX_COUNT: z.coerce.number().default(3),
  TAPD_API_BASE: z.string().url().default("https://api.tapd.cn"),
  TAPD_CLIENT_ID: z.string().optional(),
  TAPD_CLIENT_SECRET: z.string().optional(),
  TAPD_WORKSPACE_ID: z.string().optional(),
  TAPD_WORKSPACES: z.string().optional(),
});

export interface TapdConfiguredWorkspace {
  id: string;
  name?: string;
}

export interface TapdConfig {
  apiBase: string;
  clientId: string;
  clientSecret: string;
  workspaceId: string;
  workspaces: TapdConfiguredWorkspace[];
}

function loadConfig() {
  const envPath = resolve(process.cwd(), ".env");
  const parsed = envSchema.safeParse(process.env);

  if (!parsed.success) {
    const missing = parsed.error.issues
      .filter((i) => i.code === "invalid_type" && i.received === "undefined")
      .map((i) => i.path.join("."));

    console.error("\n[AI Runtime] 环境变量配置错误\n");

    if (!existsSync(envPath)) {
      console.error("未找到 .env 文件，请先创建：");
      console.error("  copy .env.example .env");
      console.error("然后编辑 .env，填写 Git 相关配置。\n");
    } else if (missing.length > 0) {
      console.error("以下配置项未填写：");
      missing.forEach((key) => console.error(`  - ${key}`));
      console.error("\n请编辑 server/.env 后重新启动。\n");
    } else {
      console.error(parsed.error.format());
    }

    process.exit(1);
  }

  return {
    ...parsed.data,
    UPLOAD_DIR: resolve(process.cwd(), parsed.data.UPLOAD_DIR),
    WORKSPACE_DIR: resolve(process.cwd(), parsed.data.WORKSPACE_DIR),
  };
}

export const config = loadConfig();

function parseTapdWorkspaces(value: string | undefined, defaultWorkspaceId: string): TapdConfiguredWorkspace[] {
  const workspaces = new Map<string, TapdConfiguredWorkspace>();
  if (defaultWorkspaceId) {
    workspaces.set(defaultWorkspaceId, { id: defaultWorkspaceId, name: `项目 ${defaultWorkspaceId}` });
  }
  for (const part of value?.split(",") ?? []) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const [idPart, ...nameParts] = trimmed.split(":");
    const id = idPart.trim();
    if (!id) continue;
    const name = nameParts.join(":").trim();
    workspaces.set(id, { id, name: name || `项目 ${id}` });
  }
  return [...workspaces.values()];
}

export function isTapdConfigured(): boolean {
  return Boolean(
    config.TAPD_CLIENT_ID && config.TAPD_CLIENT_SECRET && config.TAPD_WORKSPACE_ID
  );
}

export function getTapdConfig(): TapdConfig {
  if (!isTapdConfigured()) {
    throw new Error("TAPD 未配置");
  }
  return {
    apiBase: config.TAPD_API_BASE.replace(/\/$/, ""),
    clientId: config.TAPD_CLIENT_ID!,
    clientSecret: config.TAPD_CLIENT_SECRET!,
    workspaceId: config.TAPD_WORKSPACE_ID!,
    workspaces: parseTapdWorkspaces(config.TAPD_WORKSPACES, config.TAPD_WORKSPACE_ID!),
  };
}

export function getAuthenticatedRepoUrl(): string {
  const url = new URL(config.GIT_REPO_URL);
  url.username = "oauth2";
  url.password = config.GIT_ACCESS_TOKEN;
  return url.toString();
}
