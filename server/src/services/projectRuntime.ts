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
  await Promise.all(listProjects().map(async (project) => {
    try {
      await getProjectGitService(project.id).resetWorkspaceAfterRestart();
    } catch (err) {
      console.warn(
        `[AI Runtime] 项目 ${project.name} 重启清理失败:`,
        err instanceof Error ? err.message : String(err)
      );
    }
  }));
}
