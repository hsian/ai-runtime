import { create } from "zustand";

import type { JobEvent, JobStatus } from "../types";

interface TaskState {
  jobs: JobStatus[];
  events: Record<string, JobEvent[]>;
  selectedJobId?: string;
  remoteIp?: string;
  loading: boolean;
  setJobs: (jobs: JobStatus[]) => void;
  upsertJob: (job: JobStatus) => void;
  setEvents: (jobId: string, events: JobEvent[]) => void;
  appendEvent: (event: JobEvent) => void;
  selectJob: (jobId?: string) => void;
  setRemoteIp: (remoteIp: string) => void;
  setLoading: (loading: boolean) => void;
}

export const useTaskStore = create<TaskState>((set) => ({
  jobs: [],
  events: {},
  loading: false,
  setJobs: (jobs) => set({ jobs }),
  upsertJob: (job) =>
    set((state) => ({
      jobs: [job, ...state.jobs.filter((item) => item.jobId !== job.jobId)].sort(
        (left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime()
      ),
    })),
  setEvents: (jobId, events) => set((state) => ({ events: { ...state.events, [jobId]: events } })),
  appendEvent: (event) =>
    set((state) => {
      const current = state.events[event.jobId] ?? [];
      if (current.some((item) => item.id === event.id)) return state;
      return { events: { ...state.events, [event.jobId]: [...current, event] } };
    }),
  selectJob: (selectedJobId) => set({ selectedJobId }),
  setRemoteIp: (remoteIp) => set({ remoteIp }),
  setLoading: (loading) => set({ loading }),
}));
