import { existsSync, readFileSync } from "fs";
import { dirname, resolve } from "path";
import { z } from "zod";

import { config } from "../config.js";

const projectSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string().min(1),
  type: z.enum(["web", "wechat-mini-program", "generic"]),
  gitRepoUrl: z.string().url(),
  defaultBranch: z.string().min(1),
  packageManager: z.enum(["npm", "pnpm", "yarn"]).optional(),
  buildCommand: z.string().min(1).nullable().optional(),
  workspaceDir: z.string().min(1),
  worktreeDir: z.string().min(1),
  autoMerge: z.boolean().default(true),
  miniProgram: z.object({
    appId: z.string().regex(/^wx[a-zA-Z0-9]+$/),
    projectRoot: z.string().default("."),
    robot: z.number().int().min(1).max(30).default(1),
    privateKeyPathEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  }).optional(),
});

export type ProjectType = z.infer<typeof projectSchema>["type"];

export interface ProjectProfile {
  id: string;
  name: string;
  type: ProjectType;
  gitRepoUrl: string;
  defaultBranch: string;
  packageManager?: "npm" | "pnpm" | "yarn";
  buildCommand?: string | null;
  workspaceDir: string;
  worktreeDir: string;
  autoMerge: boolean;
  miniProgram?: {
    appId: string;
    projectRoot: string;
    robot: number;
    privateKeyPathEnv: string;
  };
}

export interface PublicProjectProfile {
  id: string;
  name: string;
  type: ProjectType;
  defaultBranch: string;
  autoMerge: boolean;
  supportsMiniProgramPreview: boolean;
  packageManager?: "npm" | "pnpm" | "yarn";
}

export const DEFAULT_PROJECT_ID = "b2b-composite";

function normalizeProject(project: z.infer<typeof projectSchema>, baseDir: string): ProjectProfile {
  return {
    ...project,
    workspaceDir: resolve(baseDir, project.workspaceDir),
    worktreeDir: resolve(baseDir, project.worktreeDir),
  };
}

function loadConfiguredProjects(): ProjectProfile[] {
  const candidates = [
    resolve(process.cwd(), "projects.json"),
    resolve(process.cwd(), "server", "projects.json"),
  ];
  const filePath = candidates.find(existsSync);
  if (!filePath) return [];
  const parsed = z.array(projectSchema).parse(JSON.parse(readFileSync(filePath, "utf8")));
  return parsed.map((project) => normalizeProject(project, dirname(filePath)));
}

const legacyProject: ProjectProfile = {
  id: DEFAULT_PROJECT_ID,
  name: "B2B 管理后台",
  type: "web",
  gitRepoUrl: config.GIT_REPO_URL,
  defaultBranch: config.GIT_DEFAULT_BRANCH,
  workspaceDir: config.WORKSPACE_DIR,
  worktreeDir: config.WORKTREE_DIR,
  autoMerge: true,
};

const configuredProjects = loadConfiguredProjects();
// 旧版部署尚未迁移 projects.json 时，继续使用 .env 中的单项目配置。
const projects = configuredProjects.some((project) => project.id === DEFAULT_PROJECT_ID)
  ? configuredProjects
  : [legacyProject, ...configuredProjects];
const projectsById = new Map(projects.map((project) => [project.id, project]));

if (projectsById.size !== projects.length) {
  throw new Error("项目配置包含重复的 id");
}

export function listProjects(): ProjectProfile[] {
  return [...projects];
}

export function listPublicProjects(): PublicProjectProfile[] {
  return projects.map((project) => ({
    id: project.id,
    name: project.name,
    type: project.type,
    defaultBranch: project.defaultBranch,
    autoMerge: project.autoMerge,
    supportsMiniProgramPreview: project.type === "wechat-mini-program" && Boolean(project.miniProgram),
    packageManager: project.packageManager,
  }));
}

export function getProject(projectId?: string): ProjectProfile {
  const id = projectId || DEFAULT_PROJECT_ID;
  const project = projectsById.get(id);
  if (!project) throw new Error(`未知项目: ${id}`);
  return project;
}
