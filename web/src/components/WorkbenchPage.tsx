import { useWorkbenchHistory } from "../workbench/useWorkbenchHistory";
import { useWorkbenchSources } from "../workbench/useWorkbenchSources";
import { useWorkbenchJobs } from "../workbench/useWorkbenchJobs";
import { mergeWorkbenchItems, findWorkbenchJob } from "../workbench/items";
import { businessProjects, monorepoProjectId, tapdStatusLabel, needsAttention, errorText, type WorkItem, type View } from "../workbench/model";
import { getTaskState } from "@ai-runtime/shared/task-state";
import { hasWorkbenchExecutionStarted } from "../utils/workbenchExecution";
import { conversationStatus } from "../utils/workbenchConversation";
import { ArrowLeftOutlined, ArrowRightOutlined, BugOutlined, CheckOutlined, CodeOutlined, DeleteOutlined, DownOutlined, ExperimentOutlined, InboxOutlined, LogoutOutlined, PlusOutlined, ReloadOutlined, SearchOutlined, UnorderedListOutlined } from "@ant-design/icons";
import { Alert, App as AntApp, Button, Checkbox, ConfigProvider, Empty, Input, Modal, Select, Spin, Tag } from "antd";
import { useEffect, useMemo, useRef, useState } from "react";

import { WorkbenchSession, type WorkbenchTaskLaunch } from "./WorkbenchSession";
import { api } from "../services/api";
import { workHoursApi, type AuthUser } from "../services/workHoursApi";
import { useTaskStore } from "../stores/taskStore";
import type { JobStatus } from "../types";
import { createUniqueId } from "../utils/uniqueId";
import { currentTapdUrl, tapdDetailUrl } from "../utils/tapdLink";
import { ChangePassword, Login } from "./AuthForms";
import { StatusBadge } from "./StatusBadge";
import "../styles/workbench.css";
import "../styles/workbench-sessions.css";

function MyWorkbench({ user, onLogout }: { user: AuthUser; onLogout: () => void }) {
  const { message } = AntApp.useApp();
  const dependencyKey = `ai-runtime:workbench-dependencies:${user.id}`;
  const [dependencyOverrides, setDependencyOverrides] = useState<Record<string, string[]>>(() => {
    try {
      const value = JSON.parse(localStorage.getItem(dependencyKey) || "{}");
      return value && typeof value === "object" && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string[]] => Array.isArray(entry[1]) && entry[1].every(id => typeof id === "string"))) : {};
    } catch { return {}; }
  });
  const [dependencyItemId, setDependencyItemId] = useState<string>();
  const [dependencyDraft, setDependencyDraft] = useState<string[]>([]);
  const [view, setView] = useState<View>("work");
  const [workType, setWorkType] = useState<"all" | "task" | "bug">("all");
  const [search, setSearch] = useState("");
  const [layout, setLayout] = useState<"board" | "list">("board");
  const [statusFilter, setStatusFilter] = useState<string>();
  const [expandedProjects, setExpandedProjects] = useState<string[]>([]);
  const [businessProject, setBusinessProject] = useState<string>(businessProjects[0]);
  const [revision, setRevision] = useState(0);
  const { saved, persist, deleteHistory: deleteStoredHistory, deletingConversation } = useWorkbenchHistory(user.id);
  const { projects, projectError, workspaces, workspaceId, iterations, iterationId, remoteItems, tapdLoading, tapdError, selectWorkspace, selectIteration } = useWorkbenchSources(revision, user.tapdOwnerName);
  const { jobs, setJobs, loading, runtimeError } = useWorkbenchJobs(revision);
  const [launch, setLaunch] = useState<WorkbenchTaskLaunch>();
  const [conversationDraft, setConversationDraft] = useState<WorkbenchTaskLaunch>(() => ({ title: "新对话", conversationId: createUniqueId(), projectId: monorepoProjectId, prompt: "", taskMode: "code", freeConversation: true }));
  const [opening, setOpening] = useState<string>();
  const openingRef = useRef(false);
  const linkedTaskOpened = useRef(false);

  const deleteHistory = (item: WorkItem) => deleteStoredHistory(item, () => {
    const sameConversation = (entry: { conversationId?: string; projectId: string }) => entry.conversationId === item.conversationId && entry.projectId === item.projectId;
    setJobs(current => current.filter(job => !sameConversation(job)));
    if (launch && sameConversation(launch)) {
      setLaunch(undefined); setConversationDraft(current => ({ ...current, conversationId: createUniqueId() }));
    }
    setRevision(value => value + 1);
  });

  useEffect(() => {
    if (!projects.length) return;
    setConversationDraft(current => projects.some(project => project.id === current.projectId) ? current : { ...current, projectId: projects[0].id });
  }, [projects]);

  useEffect(() => {
    const workspace = workspaces.find((item) => item.id === workspaceId);
    const name = workspace?.pretty_name || workspace?.name || "";
    const matched = businessProjects.find((item) => name.includes(item.replace(/项目$/, "")));
    if (matched) setBusinessProject(matched);
  }, [workspaceId, workspaces]);

  const items = useMemo(() => mergeWorkbenchItems(saved, remoteItems, jobs), [saved, remoteItems, jobs]);
  const jobFor = (item: WorkItem) => findWorkbenchJob(item, jobs);
  const visibleItems = items.filter((item) => view === "work" ? item.source === "tapd" : item.source === "manual");
  const completedInTapd = (item: WorkItem) => item.source === "tapd" && item.itemType !== "bug" && /^(done|completed|已完成)$/i.test(item.tapdStatus || "");
  const dependencyIds = (item: WorkItem) => Object.hasOwn(dependencyOverrides, item.id) ? dependencyOverrides[item.id] : (item.backendTasks || []).map(task => task.id);
  const dependencyInfo = (item: WorkItem) => {
    const ids = dependencyIds(item);
    const tasks = item.backendTasks || [];
    const done = tasks.filter(task => ids.includes(task.id) && /^(done|completed|已完成)$/i.test(task.status || "")).length;
    if (item.backendDependencyError) return { text: "依赖读取失败 · 待确认", state: "unknown" };
    if (ids.some(id => !tasks.some(task => task.id === id))) return { text: "依赖待确认 · 部分任务未读取", state: "unknown" };
    if (!ids.length) return { text: Object.hasOwn(dependencyOverrides, item.id) ? "无需后端配合" : "无后端任务 · 依赖待确认", state: "unknown" };
    return { text: `${done === ids.length ? "后端已就绪" : "等待后端"} · ${done}/${ids.length} 已完成`, state: done === ids.length ? "ready" : "waiting" };
  };
  const dependencyButton = (item: WorkItem) => {
    if (item.source !== "tapd" || item.itemType !== "task" || completedInTapd(item)) return null;
    const info = dependencyInfo(item);
    return <button className={`wb-dependency-button is-${info.state}`} aria-label={`后端依赖：${item.title}`} onClick={event => {
      event.stopPropagation(); setDependencyItemId(item.id); setDependencyDraft(dependencyIds(item));
    }}>{info.text}</button>;
  };
  const dependencyItem = items.find(item => item.id === dependencyItemId);
  const workStatus = (item: WorkItem) => {
    if (item.source === "tapd") {
      const sync = jobFor(item)?.tapdSync;
      return item.tapdStatus ? tapdStatusLabel(item.tapdStatus) : sync?.state === "synced" ? tapdStatusLabel(sync.target) : tapdStatusLabel(item.tapdStatus);
    }
    const job = jobFor(item);
    const status = job?.status;
    if (!status) return "未开始";
    if (["planning", "pending", "running"].includes(status)) return hasWorkbenchExecutionStarted(job) ? "执行中" : "未开始";
    if (status === "awaiting_input") return hasWorkbenchExecutionStarted(job) ? "执行中" : "未开始";
    if (["awaiting_confirm", "awaiting_merge"].includes(status)) return "待处理";
    return status === "completed" ? "已完成" : status === "failed" ? "失败" : "已取消";
  };
  const needsSupplement = (job?: JobStatus) => job?.taskState?.needsInput ?? getTaskState(job).needsInput;
  const boardStatus = (item: WorkItem) => {
    if (completedInTapd(item)) return "已完成";
    const job = jobFor(item);
    return job ? (job.taskState || getTaskState(job)).boardStatus : workStatus(item);
  };
  const availableStatuses = [...new Set(visibleItems.map(boardStatus))];
  const filtered = visibleItems.filter((item) => (!search || `${item.title} ${item.parentTitle || ""}`.toLowerCase().includes(search.toLowerCase())) &&
    (view !== "work" || workType === "all" || item.itemType === workType) && (!statusFilter || boardStatus(item) === statusFilter));
  const titles: Record<View, string> = { work: "我的工作", manual: "我的任务" };
  const laneOrder = ["未开始", "执行中", "待审查", "待同步", "已完成", "执行中断", "已停止"];
  const laneNames = [...new Set([...laneOrder.filter((name) => ["未开始", "执行中", "待审查", "已完成"].includes(name) || filtered.some((item) => boardStatus(item) === name)), ...filtered.map(boardStatus)])];
  const sidebarProjects = [...new Set(visibleItems.map((item) => item.businessProject || businessProject))];
  const listLoading = loading || (view === "work" && tapdLoading);
  const newConversation = () => {
    setView("manual"); setLaunch(undefined);
    setConversationDraft({ title: "新对话", conversationId: createUniqueId(), projectId: projects.find(project => project.id === conversationDraft.projectId)?.id || projects[0]?.id || "", prompt: "", taskMode: "code", freeConversation: true });
  };
  const openCreate = newConversation;

  const openItem = async (item: WorkItem) => {
    if (openingRef.current) return;
    const job = jobFor(item);
    const projectId = job ? job.projectId : item.source === "manual" ? item.projectId : monorepoProjectId;
    if (!projects.some((project) => project.id === projectId)) { message.error("B2B 管理后台仓库尚未配置，请先配置共享代码项目"); return; }
    const selectedBusinessProject = item.businessProject || businessProject;
    openingRef.current = true; setOpening(item.id);
    try {
      let context = item.tapdContext;
      if (item.source === "tapd" && item.itemType === "task" && item.workspaceId) {
        let requirementUrl = item.parentUrl;
        if (!requirementUrl) {
          const taskId = item.tapdUrl?.split("/").pop();
          const storyId = taskId ? await api.tapdTaskStoryId(item.workspaceId, taskId) : undefined;
          if (storyId) requirementUrl = tapdDetailUrl(item.workspaceId, "story", storyId);
        }
        if (!requirementUrl) throw new Error("该任务尚未关联 TAPD 需求，请先在 TAPD 关联需求后再开始任务");
        context = await api.resolveTapd(requirementUrl);
      } else if (item.tapdUrl && !job) {
        context = await api.resolveTapd(item.tapdUrl);
      }
      const workItem = { ...item, projectId, businessProject: selectedBusinessProject, conversationId: job?.conversationId || item.conversationId || createUniqueId(), tapdContext: context };
      if (!persist([...saved.filter((entry) => entry.id !== item.id), workItem])) return;
      const prompt = `${item.description || `请分析并实现：${item.title}${item.parentTitle ? `\n所属需求：${item.parentTitle}` : ""}`}\n\n所属业务项目：${selectedBusinessProject}。该业务项目位于 B2B 管理后台共享 monorepo，请定位对应业务模块后开展工作。`;
      const taskId = item.itemType === "task" ? item.tapdUrl?.split("/").pop() : undefined;
      setLaunch({ title: item.title, businessProject: selectedBusinessProject, conversationId: workItem.conversationId, projectId, prompt, taskMode: item.taskMode, tapdContext: context, tapdTask: taskId && item.workspaceId ? { workspaceId: item.workspaceId, taskId } : undefined, jobId: job?.jobId, tapdUrl: currentTapdUrl(item.tapdUrl), freeConversation: item.source === "manual" });
    } catch (error) { message.error(errorText(error)); }
    finally { openingRef.current = false; setOpening(undefined); }
  };

  useEffect(() => {
    const requested = new URLSearchParams(window.location.search).get("jobId");
    if (!requested || linkedTaskOpened.current || loading || !projects.length) return;
    const job = jobs.find(item => item.jobId === requested);
    linkedTaskOpened.current = true;
    if (!job?.workbenchSession || !job.conversationId) { message.error("该任务不存在或不属于当前登录账号"); return; }
    const local = saved.find(item => item.conversationId === job.conversationId);
    const freeConversation = !job.tapdTask && !job.tapdContext;
    if (freeConversation) setView("manual");
    setLaunch({ title: local?.title || job.tapdContext?.title || job.prompt?.split("\n")[0] || "工作台任务", businessProject: local?.businessProject,
      conversationId: job.conversationId, projectId: job.projectId, prompt: job.prompt || job.tapdContext?.description || "", taskMode: job.taskMode || "code",
      tapdContext: job.tapdContext, tapdTask: job.tapdTask, tapdUrl: job.tapdTask ? tapdDetailUrl(job.tapdTask.workspaceId, "task", job.tapdTask.taskId) : currentTapdUrl(job.tapdContext?.url || local?.tapdUrl), jobId: job.jobId, freeConversation });
  }, [jobs, loading, projects, saved, message]);

  return <div className="workbench-shell">
    <aside className="workbench-nav">
      <a className="wb-brand" href="/workbench"><span className="wb-brand-symbol">a<span>i</span></span><strong>ai-runtime</strong><span className="wb-beta">工作台</span></a>
      <Button className="wb-new" aria-label="新对话" icon={<PlusOutlined />} onClick={openCreate}>新对话</Button>
      <div className="wb-nav-caption">工作空间</div>
      <nav aria-label="工作台导航">
        {([
          ["work", <InboxOutlined />, "我的工作"], ["manual", <CodeOutlined />, "我的任务"],
        ] as const).map(([key, icon, label]) => <button key={key} aria-label={label} className={`wb-nav-item${view === key && (!launch || (key === "manual" && launch.freeConversation)) ? " is-selected" : ""}`} onClick={() => { setLaunch(undefined); setView(key); setSearch(""); setStatusFilter(undefined); setWorkType("all"); }} aria-current={view === key && (!launch || (key === "manual" && launch.freeConversation)) ? "page" : undefined}>{icon}<span>{label}</span></button>)}
      </nav>
      <div className="wb-project-heading">{view === "manual" ? "历史对话" : "项目"} <span>{view === "manual" ? visibleItems.length : sidebarProjects.length}</span></div>
      <div className="wb-sidebar-sessions">
        {view === "manual" ? visibleItems.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(item => <div className="wb-sidebar-history-row" key={item.id}>
          <button className={`wb-sidebar-session${launch?.conversationId === item.conversationId ? " is-current" : ""}`} aria-label={`打开对话：${item.title}`} onClick={() => void openItem(item)} disabled={Boolean(deletingConversation)}><span>{item.title}</span><small>{projects.find(project => project.id === item.projectId)?.name || item.projectId} · {conversationStatus(jobFor(item))}</small></button>
          <Button type="text" size="small" danger icon={<DeleteOutlined />} aria-label={`删除对话：${item.title}`} title="删除对话" loading={deletingConversation === item.conversationId} disabled={Boolean(deletingConversation)} onClick={() => deleteHistory(item)} />
        </div>) : sidebarProjects.map((name) => <section className="wb-sidebar-project" key={name}>
          <button className="wb-project-toggle" aria-expanded={expandedProjects.includes(name)} onClick={() => setExpandedProjects((current) => current.includes(name) ? current.filter((entry) => entry !== name) : [...current, name])}>{name}<DownOutlined /></button>
          {expandedProjects.includes(name) && visibleItems.filter((item) => (item.businessProject || businessProject) === name).map((item) => <button className={`wb-sidebar-session${launch?.conversationId && launch.conversationId === item.conversationId ? " is-current" : ""}`} key={item.id} aria-label={`打开任务：${item.title}`} onClick={() => void openItem(item)} disabled={Boolean(opening)}><span>{item.title}</span><small>{item.itemType === "bug" ? <BugOutlined /> : <CodeOutlined />}{workStatus(item)}</small></button>)}
        </section>)}
        {!sidebarProjects.length && <p className="wb-sidebar-empty">{view === "manual" ? "开始聊天后，对话会保存在这里" : "任务将在这里按项目展示"}</p>}
      </div>
      <div className="wb-nav-bottom">
        <a href="/"><ArrowLeftOutlined /> 返回原工作台</a>
        <div className="wb-account"><span className="wb-avatar">{(user.displayName || user.username).slice(0, 1)}</span><div><strong>{user.displayName || user.username}</strong><small>{user.tapdOwnerName || "尚未绑定 TAPD"}</small></div><Button type="text" icon={<LogoutOutlined />} aria-label="退出登录" onClick={onLogout} /></div>
      </div>
    </aside>

    <section className="wb-main">
      <header className="wb-topbar"><div className="wb-page-title"><Button type="text" icon={<ArrowLeftOutlined />} aria-label={launch ? "返回任务列表" : "返回原工作台"} onClick={() => launch ? setLaunch(undefined) : window.location.assign("/")} /><h1>{launch ? launch.title : titles[view]}</h1>{launch?.tapdUrl && <a className="wb-title-tapd-link" href={launch.tapdUrl} aria-label="在 TAPD 查看" title="在 TAPD 查看" target="_blank" rel="noreferrer">↗</a>}</div></header>
      {launch || view === "manual" ? <div className="wb-execution-wrap"><WorkbenchSession key={(launch || conversationDraft).conversationId} task={launch || conversationDraft} onChanged={() => setRevision(value => value + 1)} projects={projects} onProjectChange={projectId => setConversationDraft(current => ({ ...current, projectId }))} onStarted={text => {
        if (launch || view !== "manual") return;
        const item: WorkItem = { id: createUniqueId(), title: text.slice(0, 60), description: text, source: "manual", projectId: conversationDraft.projectId, businessProject: conversationDraft.businessProject, taskMode: "code", conversationId: conversationDraft.conversationId, createdAt: new Date().toISOString() };
        persist([item, ...saved]);
        setLaunch({ ...conversationDraft, title: item.title, prompt: text });
        setConversationDraft({ ...conversationDraft, conversationId: createUniqueId() });
      }} /></div> :
      <main className="wb-content wb-sessions">
        <div className="wb-session-toolbar">
          <div className="wb-layout-switch" role="group" aria-label="视图">
            <button aria-pressed={layout === "board"} onClick={() => setLayout("board")}>看板</button>
            <button aria-pressed={layout === "list"} onClick={() => setLayout("list")}>列表</button>
          </div>
          <Input className="wb-session-search" aria-label="搜索任务" prefix={<SearchOutlined />} placeholder="搜索任务…" value={search} onChange={(event) => setSearch(event.target.value)} allowClear />
          <Button type="text" aria-label="刷新任务" icon={<ReloadOutlined />} loading={listLoading} onClick={() => setRevision((value) => value + 1)}>刷新</Button>
        </div>
        <div className="wb-session-filters">
          <Select aria-label="状态筛选" placeholder="状态" value={statusFilter} onChange={setStatusFilter} allowClear options={availableStatuses.map((name) => ({ value: name, label: name }))} />
          {view === "work" && <><Select aria-label="TAPD 项目" placeholder="TAPD 项目" value={workspaceId} onChange={selectWorkspace} options={workspaces.map((item) => ({ value: item.id, label: item.pretty_name || item.name || item.id }))} />
          <Select className="wb-iteration-select" aria-label="迭代" placeholder="选择迭代" value={iterationId} onChange={selectIteration} loading={tapdLoading} options={iterations.map((item) => ({ value: item.id, label: item.name }))} /></>}
          {view !== "work" && <Select aria-label="业务项目" placeholder="业务项目" value={businessProject} onChange={setBusinessProject} options={businessProjects.map((name) => ({ value: name, label: name }))} />}
          {view === "work" && <div className="wb-work-types" role="group" aria-label="工作类型">{([["all", "全部"], ["task", "任务"], ["bug", "Bug"]] as const).map(([value, label]) => <button key={value} aria-label={label} aria-pressed={workType === value} onClick={() => setWorkType(value)}>{label}</button>)}</div>}
          <Button type="text" className="wb-clear-filters" onClick={() => { setSearch(""); setStatusFilter(undefined); setWorkType("all"); }}>清除筛选</Button>
        </div>
        {(runtimeError || projectError) && <Alert type="error" showIcon message={runtimeError || projectError} action={<Button onClick={() => setRevision((value) => value + 1)}>重试</Button>} />}
        {view === "work" && !user.tapdOwnerName.trim() && <Alert type="info" showIcon message="请在账号管理中绑定 TAPD 处理人。" />}
        {view === "work" && tapdError && <Alert type="warning" showIcon message={tapdError} />}
        <div className="wb-session-results" aria-busy={listLoading}>
          {listLoading ? <div className="wb-empty"><Spin tip="正在读取任务"><div style={{ padding: 32 }} /></Spin></div> : filtered.length === 0 ? <div className="wb-empty"><Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={search || statusFilter ? "没有匹配的任务" : "这里还没有任务"} /><p>{view === "work" ? "选择项目与迭代，读取自己的 TAPD 任务和 Bug。" : "新建任务，开始一次需求分析或代码修改。"}</p>{view !== "work" && <Button icon={<PlusOutlined />} onClick={openCreate}>新对话</Button>}</div> : layout === "board" ? (
            <div className="wb-board">{laneNames.map((name) => {
              const laneItems = filtered.filter((item) => boardStatus(item) === name);
              return <section className="wb-board-lane" key={name} aria-label={name}>
                <header><span className={["已完成", "已解决", "已关闭", "已验证"].includes(name) ? "wb-lane-done" : ""}>{["已完成", "已解决", "已关闭", "已验证"].includes(name) ? <CheckOutlined /> : <UnorderedListOutlined />}{name === "待审查" ? "待审查（Review）" : name} <small>{laneItems.length}</small></span></header>
                {laneItems.map((item) => {
                  const job = jobFor(item);
                  return <article className="wb-board-card" key={item.id} onClick={() => void openItem(item)} aria-busy={opening === item.id}>
                    <div className="wb-card-project">{item.businessProject || businessProject}{!completedInTapd(item) && needsSupplement(job) && <Tag className="wb-supplement-tag" color="orange">待补充</Tag>}</div>
                    <button className="wb-task-title" disabled={Boolean(opening)}>{item.title}</button>
                    {dependencyButton(item)}
                    {!completedInTapd(item) && job && ["planning", "pending", "running"].includes(job.status) && <i className="wb-card-live" aria-label="AI 正在执行" />}
                    <div className="wb-card-footer">{item.itemType === "bug" ? <BugOutlined /> : item.taskMode === "test-case" ? <ExperimentOutlined /> : <CodeOutlined />}<span>{opening === item.id ? "正在读取需求…" : completedInTapd(item) ? "TAPD · 已完成" : job ? `${item.source === "tapd" ? "TAPD · " + workStatus(item) + " · " : ""}${job.message || (needsAttention(job) ? "等待你处理" : "查看执行进展")}` : item.source === "tapd" ? "TAPD · " + workStatus(item) : "尚未开始执行"}</span>{item.tapdUrl && <a href={currentTapdUrl(item.tapdUrl)} aria-label="在 TAPD 查看" target="_blank" rel="noreferrer" onClick={(event) => event.stopPropagation()}>↗</a>}</div>
                  </article>;
                })}
              </section>;
            })}</div>
          ) : <div className="wb-task-list">{filtered.map((item) => {
            const job = jobFor(item);
          return <article className="wb-task-row" key={item.id}><span className={`wb-task-icon ${item.source}`}>{item.itemType === "bug" ? <BugOutlined /> : item.source === "tapd" ? <UnorderedListOutlined /> : item.taskMode === "test-case" ? <ExperimentOutlined /> : <CodeOutlined />}</span><div className="wb-task-text"><button className="wb-task-title" disabled={Boolean(opening)} onClick={() => void openItem(item)}>{item.title}</button><div className="wb-task-meta">{dependencyButton(item)}{!completedInTapd(item) && needsSupplement(job) && <Tag className="wb-supplement-tag" color="orange">{hasWorkbenchExecutionStarted(job) ? "执行中 · 待补充" : "未开始 · 待补充"}</Tag>}<span>{item.source === "tapd" ? item.itemType === "bug" ? "TAPD · Bug" : "TAPD · 任务" : "手动创建"}</span><span>{item.businessProject || (item.source === "tapd" ? businessProject : "未选择业务项目")}</span>{item.tapdUrl && <a href={currentTapdUrl(item.tapdUrl)} target="_blank" rel="noreferrer">查看 TAPD ↗</a>}</div>{item.source === "tapd" && !completedInTapd(item) && job && <div className="wb-task-progress">AI 执行：<StatusBadge status={job.status} /></div>}{!completedInTapd(item) && job?.message && <p className="wb-task-progress">{job.message}</p>}</div><div className="wb-task-actions">{item.source === "tapd" ? <Tag>{tapdStatusLabel(item.tapdStatus)}</Tag> : job ? <StatusBadge status={job.status} /> : <Tag>待开始</Tag>}<Button size="small" loading={opening === item.id} disabled={Boolean(opening) && opening !== item.id} onClick={() => void openItem(item)}>{completedInTapd(item) ? "查看记录" : job ? needsAttention(job) ? "去处理" : "查看执行" : "开始任务"}<ArrowRightOutlined /></Button></div></article>;
          })}</div>}
        </div>
        <div className="wb-session-footnote">{filtered.length} 项 · {view === "work" ? "工作状态来自 TAPD" : "手动任务保存在当前浏览器"}</div>
      </main>}
    </section>


    <Modal title="后端依赖" open={Boolean(dependencyItem)} onCancel={() => setDependencyItemId(undefined)} footer={[
      <Button key="auto" onClick={() => { if (dependencyItem) setDependencyDraft((dependencyItem.backendTasks || []).map(task => task.id)); }}>选择全部</Button>,
      <Button key="cancel" onClick={() => setDependencyItemId(undefined)}>关闭</Button>,
      <Button key="save" type="primary" onClick={() => {
        if (!dependencyItem) return;
        const next = { ...dependencyOverrides, [dependencyItem.id]: dependencyDraft };
        try { localStorage.setItem(dependencyKey, JSON.stringify(next)); setDependencyOverrides(next); setDependencyItemId(undefined); }
        catch { message.error("依赖设置保存失败，请检查浏览器存储空间"); }
      }}>保存依赖</Button>,
    ]}>
      <p>{dependencyItem?.title}</p>
      <p>默认关联同一需求下名称以“后端”开头的任务，包括其他迭代。取消勾选不影响你的任务，全部取消表示无需后端配合。</p>
      {dependencyItem?.backendDependencyError && <Alert type="warning" showIcon message={dependencyItem.backendDependencyError} />}
      {!dependencyItem?.backendTasks?.length && <p>没有读取到同需求的后端任务，请确认是否需要后端配合。</p>}
      <div className="wb-dependency-list">{dependencyItem?.backendTasks?.map(task => <div className="wb-dependency-row" key={task.id}>
        <Checkbox checked={dependencyDraft.includes(task.id)} onChange={event => setDependencyDraft(current => event.target.checked ? [...current, task.id] : current.filter(id => id !== task.id))}>{task.name}</Checkbox>
        <span>{task.owner || "未分配负责人"} · {tapdStatusLabel(task.status)}</span>
        <a href={tapdDetailUrl(dependencyItem.workspaceId!, "task", task.id)} target="_blank" rel="noreferrer">查看 TAPD ↗</a>
      </div>)}</div>
      {dependencyDraft.filter(id => !dependencyItem?.backendTasks?.some(task => task.id === id)).map(id => <p key={id}>任务 {id} 未读取到最新状态，请核对 TAPD 后再调整依赖。<Button size="small" type="link" onClick={() => setDependencyDraft(current => current.filter(value => value !== id))}>移除关联</Button></p>)}
      <p className="wb-chat-muted">依赖选择保存在当前账号的浏览器中。手动刷新看板时更新状态；后端标记完成后，仍需核对接口文档。</p>
    </Modal>
  </div>;
}

export default function WorkbenchPage() {
  const [user, setUser] = useState<AuthUser | null>();
  const [error, setError] = useState("");
  useEffect(() => {
    document.title = "任务工作台 · ai-runtime";
    let current = true;
    workHoursApi.me().then((result) => { if (current) setUser(result.user); }).catch((reason) => { if (current) setError(errorText(reason)); });
    return () => { current = false; };
  }, []);
  const { message } = AntApp.useApp();
  return <ConfigProvider theme={{
    token: { colorPrimary: "#262626", colorInfo: "#525252", borderRadius: 6, colorBgLayout: "#fafafa" },
    components: {
      Select: {
        colorText: "#27272a",
        colorTextPlaceholder: "#71717a",
        colorBgElevated: "#ffffff",
        selectorBg: "#ffffff",
        optionSelectedBg: "#eef0f3",
        optionSelectedColor: "#18181b",
        optionActiveBg: "#f4f4f5",
        controlItemBgActiveHover: "#e4e7eb",
        optionFontSize: 13,
        optionHeight: 36,
        optionPadding: "8px 12px",
        activeBorderColor: "#a1a1aa",
        hoverBorderColor: "#a1a1aa",
        activeOutlineColor: "rgba(113, 113, 122, 0.12)",
      },
    },
  }}>
    {error ? <div className="wb-auth"><Alert type="error" showIcon message={error} action={<Button onClick={() => window.location.reload()}>重新加载</Button>} /></div> : user === undefined ? <div className="wb-auth"><Spin /></div> : user === null ? <div className="wb-auth"><a className="wb-auth-back" href="/">← 返回原工作台</a><Login onLogin={setUser} /></div> : user.mustChangePassword ? <div className="wb-auth"><ChangePassword initial onChanged={setUser} /></div> : <MyWorkbench key={user.id} user={user} onLogout={() => {
      void workHoursApi.logout().then(() => { useTaskStore.getState().setJobs([]); useTaskStore.getState().selectJob(undefined); setUser(null); }).catch((reason) => message.error(errorText(reason)));
    }} />}
  </ConfigProvider>;
}
