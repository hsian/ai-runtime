import type {
  AgentProvider,
  JobEvent,
  JobStatus,
  OperationLogEntry,
  SubmitInput,
  SubmitResponse,
  TapdContext,
  TapdIteration,
  TapdImageOption,
  TapdWorkspace,
} from "../types";

function dataUrlToBlob(dataUrl: string, typeHint?: string): Blob {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(dataUrl);
  if (!match) throw new Error("TAPD 图片数据无效");
  const binary = match[2] ? atob(match[3]) : decodeURIComponent(match[3]);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type: typeHint || match[1] || "image/png" });
}

async function readJson<T>(response: Response): Promise<T> {
  const text = await response.text();
  let data: T & { error?: string };
  try {
    data = JSON.parse(text) as T & { error?: string };
  } catch {
    throw new Error(response.ok ? "服务端返回了无效数据" : `服务暂不可用: ${response.status}`);
  }
  if (!response.ok) throw new Error(data.error || `请求失败: ${response.status}`);
  return data;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  return readJson<T>(
    await fetch(path, {
      credentials: "same-origin",
      ...init,
      headers: init?.body instanceof FormData
        ? init.headers
        : { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    })
  );
}

function submitBody(input: SubmitInput): BodyInit {
  if (input.images?.length) {
    const form = new FormData();
    form.append("prompt", input.prompt);
    form.append("conversationId", input.conversationId);
    if (input.agentProvider) form.append("agentProvider", input.agentProvider);
    if (input.tapdContext) form.append("tapdContext", JSON.stringify(input.tapdContext));
    input.images.forEach((image, index) => {
      form.append("images", image, input.imageNames?.[index] || `screenshot-${index + 1}.webp`);
    });
    return form;
  }
  return JSON.stringify({
    prompt: input.prompt,
    conversationId: input.conversationId,
    agentProvider: input.agentProvider,
    tapdContext: input.tapdContext,
  });
}

export const api = {
  async getClient(): Promise<{ remoteIp: string }> {
    return request("/api/client");
  },

  async listJobs(): Promise<JobStatus[]> {
    const data = await request<{ jobs: JobStatus[] }>("/api/jobs");
    return data.jobs ?? [];
  },

  async getJob(jobId: string): Promise<JobStatus> {
    return request(`/api/jobs/${encodeURIComponent(jobId)}`);
  },

  async getEvents(jobId: string): Promise<JobEvent[]> {
    const data = await request<{ events: JobEvent[] }>(`/api/jobs/${encodeURIComponent(jobId)}/events`);
    return data.events ?? [];
  },

  async submit(input: SubmitInput, modifyCode: boolean): Promise<SubmitResponse> {
    return request(modifyCode ? "/api/jobs/plan" : "/api/jobs", {
      method: "POST",
      body: submitBody(input),
    });
  },

  async execute(jobId: string, planSummary: string | undefined, agentProvider: AgentProvider): Promise<SubmitResponse> {
    return request(`/api/jobs/${encodeURIComponent(jobId)}/execute`, {
      method: "POST",
      body: JSON.stringify({ planSummary, agentProvider }),
    });
  },

  async cancel(jobId: string): Promise<void> {
    await request(`/api/jobs/${encodeURIComponent(jobId)}/cancel`, { method: "POST", body: "{}" });
  },

  async deleteConversation(conversationId: string): Promise<{ deleted: number }> {
    return request(`/api/jobs/conversation/${encodeURIComponent(conversationId)}`, { method: "DELETE" });
  },

  async merge(jobId: string, createMergeRequest = false): Promise<SubmitResponse> {
    return request(`/api/jobs/${encodeURIComponent(jobId)}/merge`, {
      method: "POST",
      body: JSON.stringify({ createMergeRequest }),
    });
  },

  async discardMerge(jobId: string): Promise<void> {
    await request(`/api/jobs/${encodeURIComponent(jobId)}/discard-merge`, { method: "POST", body: "{}" });
  },

  async releaseBranches(jobId: string): Promise<string[]> {
    const data = await request<{ branches: string[] }>(`/api/jobs/${encodeURIComponent(jobId)}/release-branches`);
    return data.branches ?? [];
  },

  async mergeToRelease(jobId: string, targetBranch: string): Promise<JobStatus> {
    const data = await request<{ job: JobStatus }>(`/api/jobs/${encodeURIComponent(jobId)}/release-merge`, {
      method: "POST",
      body: JSON.stringify({ targetBranch }),
    });
    return data.job;
  },

  async revert(jobId: string): Promise<JobStatus> {
    const data = await request<{ job: JobStatus }>(`/api/jobs/${encodeURIComponent(jobId)}/revert-default`, {
      method: "POST",
      body: "{}",
    });
    return data.job;
  },

  async resolveTapd(url: string): Promise<TapdContext> {
    const data = await request<{ context: TapdContext }>("/api/tapd/context/resolve", {
      method: "POST",
      body: JSON.stringify({ url }),
    });
    return data.context;
  },

  async tapdDescriptionImages(context: TapdContext): Promise<TapdImageOption[]> {
    if (!context.sourceHtml || !context.imageCount) return [];
    const data = await request<{
      images?: Array<{ dataUrl: string; mime?: string; name?: string }>;
    }>("/api/tapd/images/from-html", {
      method: "POST",
      body: JSON.stringify({ html: context.sourceHtml, workspaceId: context.workspaceId }),
    });
    return (data.images ?? []).map((item, index) => {
      const blob = dataUrlToBlob(item.dataUrl, item.mime);
      const parsedIndex = Number.parseInt(/tapd-(\d+)/i.exec(item.name ?? "")?.[1] ?? "", 10);
      return {
        sourceIndex: Number.isFinite(parsedIndex) ? parsedIndex : index + 1,
        blob,
        previewUrl: URL.createObjectURL(blob),
        selected: false,
      };
    });
  },

  async tapdWorkspaces(): Promise<{ defaultWorkspaceId: string; workspaces: TapdWorkspace[] }> {
    return request("/api/tapd/workspaces");
  },

  async tapdIterations(workspaceId: string): Promise<{ iterations: TapdIteration[] }> {
    return request(`/api/tapd/iterations?workspaceId=${encodeURIComponent(workspaceId)}`);
  },

  async createTapdBug(input: { title: string; description: string; workspaceId: string; iterationId: string }): Promise<void> {
    await request("/api/tapd/bugs", { method: "POST", body: JSON.stringify(input) });
  },

  async operationLogDates(): Promise<string[]> {
    const data = await request<{ dates: string[] }>("/api/operation-logs/dates");
    return data.dates ?? [];
  },

  async operationLogs(date: string): Promise<OperationLogEntry[]> {
    const data = await request<{ entries: OperationLogEntry[] }>(`/api/operation-logs?date=${encodeURIComponent(date)}&limit=500`);
    return data.entries ?? [];
  },
};

export function openJobStream(jobId: string, onEvent: (event: JobEvent) => void): EventSource {
  const source = new EventSource(`/api/jobs/${encodeURIComponent(jobId)}/stream`);
  source.onmessage = (message) => {
    try {
      onEvent(JSON.parse(message.data) as JobEvent);
    } catch {
      // Ignore malformed server events.
    }
  };
  source.addEventListener("close", () => source.close());
  return source;
}
