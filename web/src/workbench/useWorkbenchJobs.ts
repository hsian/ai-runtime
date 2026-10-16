import { useEffect, useState } from "react";
import { openWorkbenchStream } from "../services/api";
import type { JobStatus } from "../types";

/** One account-scoped subscription, released when refreshing or unmounting. */
export function useWorkbenchJobs(revision: number) {
  const [jobs, setJobs] = useState<JobStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [runtimeError, setRuntimeError] = useState("");

  useEffect(() => {
    const source = openWorkbenchStream({
      snapshot: items => { setJobs(items); setRuntimeError(""); setLoading(false); },
      upsert: item => { setJobs(current => [item, ...current.filter(job => job.jobId !== item.jobId)]); setRuntimeError(""); },
      remove: id => setJobs(current => current.filter(job => job.jobId !== id)),
      error: () => { setRuntimeError("任务状态连接中断，正在重新连接；也可以手动刷新。"); setLoading(false); },
    });
    return () => source.close();
  }, [revision]);

  return { jobs, setJobs, loading, runtimeError };
}
