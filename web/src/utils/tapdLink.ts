export function tapdDetailUrl(workspaceId: string, type: "story" | "task" | "bug", itemId: string): string {
  return `https://www.tapd.cn/tapd_fe/${encodeURIComponent(workspaceId)}/${type}/detail/${encodeURIComponent(itemId)}`;
}

export function currentTapdUrl(url?: string): string | undefined {
  return url?.replace(/https:\/\/www\.tapd\.cn\/([^/]+)\/(stories|tasks|bugs)\/view\/([^/?#]+)/,
    (_match, workspace: string, type: string, id: string) => tapdDetailUrl(workspace, type === "stories" ? "story" : type === "tasks" ? "task" : "bug", id));
}
