export interface AuthUser {
  id: string;
  username: string;
  displayName: string;
  tapdOwnerName: string;
  role: "admin" | "member";
  permissions: string[];
  mustChangePassword: boolean;
}

export interface WorkTask {
  id: string; workspaceId: string; projectName: string; name: string; completed: string;
  currentHours: string; currentPages: string;
  description: string;
}

export interface WorkProposal {
  id: string; workspaceId: string; hours: number; pages: number; score: number;
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    credentials: "same-origin", ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `请求失败: ${response.status}`);
  return data as T;
}

const post = <T>(path: string, body: unknown) => call<T>(path, { method: "POST", body: JSON.stringify(body) });

export const workHoursApi = {
  me: () => call<{ user: AuthUser | null }>("/api/auth/me"),
  login: (username: string, password: string) => post<{ user: AuthUser }>("/api/auth/login", { username, password }),
  logout: () => post<{ ok: boolean }>("/api/auth/logout", {}),
  changePassword: (currentPassword: string, newPassword: string) => post<{ user: AuthUser }>("/api/auth/change-password", { currentPassword, newPassword }),
  projects: () => call<{ projects: Array<{ id: string; name: string }> }>("/api/tapd/work-hours/projects"),
  preview: (month: string, targetHours: number, workspaceIds: string[]) => post<{ tasks: WorkTask[]; proposals: WorkProposal[] }>("/api/tapd/work-hours/preview", { month, targetHours, workspaceIds }),
  apply: (month: string, workspaceIds: string[], entries: Array<WorkProposal & { expectedHours: string; expectedPages: string }>) => post<{ results: Array<{ id: string; workspaceId: string; ok: boolean; error?: string }> }>("/api/tapd/work-hours/apply", { month, workspaceIds, entries }),
  users: () => call<{ users: ManagedUser[] }>("/api/admin/users"),
  createUser: (input: { username: string; displayName: string; tapdOwnerName: string; role: "admin" | "member" }) => post<{ initialPassword: string }>("/api/admin/users", input),
  updateUser: (id: string, input: { displayName: string; tapdOwnerName: string; role: "admin" | "member"; enabled: boolean }) => call<{ ok: boolean }>(`/api/admin/users/${id}`, { method: "PATCH", body: JSON.stringify(input) }),
  resetPassword: (id: string) => post<{ initialPassword: string }>(`/api/admin/users/${id}/reset-password`, {}),
};

export interface ManagedUser {
  id: string; username: string; display_name: string; tapd_owner_name: string;
  role: "admin" | "member"; enabled: number; must_change_password: number; created_at: string;
}
