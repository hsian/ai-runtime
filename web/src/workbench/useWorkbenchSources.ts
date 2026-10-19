import { App as AntApp } from "antd";
import { isBackendTaskName } from "@ai-runtime/shared/tapd-task";
import { useEffect, useRef, useState } from "react";
import { api } from "../services/api";
import type { ProjectProfile, TapdIteration, TapdWorkspace } from "../types";
import { tapdDetailUrl } from "../utils/tapdLink";
import { errorText, isOwner, type WorkItem } from "./model";

function rememberIteration(workspaceId: string, iterationId?: string) {
  const url = new URL(window.location.href);
  url.searchParams.set("workspaceId", workspaceId);
  if (iterationId) url.searchParams.set("iterationId", iterationId);
  else url.searchParams.delete("iterationId");
  window.history.replaceState(window.history.state, "", url);
}

/** Load on explicit refresh or scope changes; ignore superseded responses. */
export function useWorkbenchSources(revision: number, ownerName: string) {
  const { message } = AntApp.useApp();
  const [projects, setProjects] = useState<ProjectProfile[]>([]);
  const [workspaces, setWorkspaces] = useState<TapdWorkspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState<string>();
  const sharedScope = useRef<{ workspaceId?: string; iterationId?: string }>({});
  const [iterations, setIterations] = useState<TapdIteration[]>([]);
  const [iterationId, setIterationId] = useState<string>();
  const [remoteItems, setRemoteItems] = useState<WorkItem[]>([]);
  const [tapdLoading, setTapdLoading] = useState(false);
  const [tapdError, setTapdError] = useState("");
  const [projectError, setProjectError] = useState("");

  useEffect(() => {
    let current = true;
    api.listProjects().then((items) => { if (current) { setProjects(items); setProjectError(""); } }).catch((error) => { if (current) setProjectError(errorText(error)); });
    Promise.all([api.tapdWorkspaces(), api.workbenchPreferences()]).then(([result, preferences]) => {
      if (current) {
        sharedScope.current = preferences;
        setWorkspaces(result.workspaces);
        const requested = new URLSearchParams(window.location.search).get("workspaceId");
        setWorkspaceId(previous => [requested, previous, preferences.workspaceId, result.defaultWorkspaceId, result.workspaces[0]?.id]
          .find(id => result.workspaces.some(workspace => workspace.id === id)) || undefined);
      }
    }).catch((error) => { if (current) setTapdError(errorText(error)); });
    return () => { current = false; };
  }, [revision]);

  useEffect(() => {
    let current = true;
    setIterations([]); setIterationId(undefined); setRemoteItems([]);
    if (workspaceId) {
      setTapdLoading(true);
      api.tapdIterations(workspaceId).then((result) => {
        if (!current) return;
        setIterations(result.iterations);
        const params = new URLSearchParams(window.location.search);
        const requested = !params.get("workspaceId") || params.get("workspaceId") === workspaceId
          ? params.get("iterationId") || (sharedScope.current.workspaceId === workspaceId ? sharedScope.current.iterationId : undefined) : undefined;
        const selected = result.iterations.find(item => item.id === requested)?.id
          || result.iterations.find((item) => /^(open|running|active|进行中)$/i.test(item.status || ""))?.id || result.iterations[0]?.id;
        setIterationId(selected);
        rememberIteration(workspaceId, selected);
        if (sharedScope.current.workspaceId !== workspaceId || sharedScope.current.iterationId !== selected) {
          sharedScope.current = { workspaceId, iterationId: selected };
          void api.saveWorkbenchPreferences(sharedScope.current).catch(error => message.error(`项目和迭代同步失败：${errorText(error)}`));
        }
        setTapdError("");
      }).catch((error) => { if (current) setTapdError(errorText(error)); }).finally(() => { if (current) setTapdLoading(false); });
    }
    return () => { current = false; };
  }, [workspaceId, revision]);

  useEffect(() => {
    let current = true;
    if (workspaceId && iterationId && ownerName.trim()) {
      if (!remoteItems.length) setTapdLoading(true);
      Promise.allSettled([api.tapdIterationItems(workspaceId, iterationId), api.tapdIterationBugs(workspaceId, iterationId)]).then(([taskResult, bugResult]) => {
        if (!current) return;
        const items: WorkItem[] = [];
        const append = (item: { id: string; name: string; status?: string }, type: "task" | "bug", parentTitle?: string, parentId?: string) => {
          items.push({ id: `${workspaceId}:${type}:${item.id}`, title: item.name, description: "", source: "tapd", itemType: type, projectId: "", taskMode: "code", conversationId: "", createdAt: "", workspaceId, iterationId, parentTitle, parentUrl: parentId ? tapdDetailUrl(workspaceId, "story", parentId) : undefined, tapdStatus: item.status, tapdUrl: tapdDetailUrl(workspaceId, type, item.id), backendTasks: type === "task" && taskResult.status === "fulfilled" ? taskResult.value.backendDependencies?.[item.id] || taskResult.value.stories.find(story => story.id === parentId)?.tasks.filter(task => isBackendTaskName(task.name) && task.id !== item.id) : undefined, backendDependencyError: taskResult.status === "fulfilled" ? taskResult.value.backendDependencyError : undefined });
        };
        if (taskResult.status === "fulfilled") {
          taskResult.value.stories.forEach((story) => {
            story.tasks.filter((task) => isOwner(task.owner, ownerName)).forEach((task) => append(task, "task", story.name, story.id));
          });
          taskResult.value.orphanTasks.filter((task) => isOwner(task.owner, ownerName)).forEach((task) => append(task, "task"));
        }
        if (bugResult.status === "fulfilled") {
          bugResult.value.bugs.filter((bug) => isOwner(bug.owner, ownerName)).forEach((bug) => append(bug, "bug"));
        }
        setRemoteItems(items);
        setTapdError([taskResult.status === "rejected" ? `任务读取失败：${errorText(taskResult.reason)}` : "", bugResult.status === "rejected" ? `Bug 读取失败：${errorText(bugResult.reason)}` : ""].filter(Boolean).join("；"));
      }).catch((error) => { if (current) setTapdError(errorText(error)); }).finally(() => { if (current) setTapdLoading(false); });
    } else setRemoteItems([]);
    return () => { current = false; };
  }, [workspaceId, iterationId, ownerName, revision]);

  const selectWorkspace = (id: string) => {
    rememberIteration(id); setIterationId(undefined); setIterations([]); setWorkspaceId(id);
  };
  const selectIteration = (id: string) => {
    setIterationId(id);
    if (workspaceId) {
      rememberIteration(workspaceId, id);
      sharedScope.current = { workspaceId, iterationId: id };
      void api.saveWorkbenchPreferences(sharedScope.current).catch(error => message.error(`项目和迭代同步失败：${errorText(error)}`));
    }
  };
  return { projects, projectError, workspaces, workspaceId, iterations, iterationId, remoteItems, tapdLoading, tapdError, selectWorkspace, selectIteration };
}
