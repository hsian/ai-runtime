import { GitService } from "./gitService.js";
import { getProject, listProjects } from "./projectRegistry.js";

const gitServices = new Map<string, GitService>();

export function getProjectGitService(projectId?: string): GitService {
  const project = getProject(projectId);
  let service = gitServices.get(project.id);
  if (!service) {
    service = new GitService(project);
    gitServices.set(project.id, service);
  }
  return service;
}

export async function resetAllProjectWorkspaces(): Promise<void> {
  const projects = listProjects();
  console.log(`[AI Runtime] 开始初始化 ${projects.length} 个项目仓库...`);

  for (const project of projects) {
    console.log(`[AI Runtime] 正在检查项目仓库：${project.name}`);
    try {
      await getProjectGitService(project.id).resetWorkspaceAfterRestart();
      console.log(`[AI Runtime] 项目仓库已就绪：${project.name} (${project.defaultBranch})`);
    } catch (err) {
      throw new Error(
        `项目 ${project.name} 初始化失败：${err instanceof Error ? err.message : String(err)}`,
        { cause: err }
      );
    }
  }

  console.log("[AI Runtime] 所有项目仓库初始化完成");
}
