import type { JobStatus } from "../types";

export function hasWorkbenchExecutionStarted(job?: JobStatus): boolean {
  if (!job || job.workbenchReset) return false;
  if (job.workbenchExecutionStarted !== undefined) return job.workbenchExecutionStarted;
  // Compatibility for sessions created before the explicit execution marker.
  return job.workbenchInputSource === "implementation" || job.workbenchHasCodeChanges === true
    || Boolean(job.commitSha && job.commitSha !== job.workbenchBaseCommitSha)
    || (job.status === "running" && job.taskMode !== "test-case");
}
