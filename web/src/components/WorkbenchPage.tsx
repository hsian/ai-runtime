import { ArrowLeftOutlined, ArrowRightOutlined, BugOutlined, CheckOutlined, CodeOutlined, DownOutlined, ExperimentOutlined, InboxOutlined, LogoutOutlined, PlusOutlined, ReloadOutlined, SearchOutlined, UnorderedListOutlined } from "@ant-design/icons";
import { Alert, App as AntApp, Button, ConfigProvider, Empty, Form, Input, Modal, Select, Spin, Tag } from "antd";
import { useEffect, useMemo, useRef, useState } from "react";

import { WorkbenchSession, type WorkbenchTaskLaunch } from "./WorkbenchSession";
import { api } from "../services/api";
import { workHoursApi, type AuthUser } from "../services/workHoursApi";
import { useTaskStore } from "../stores/taskStore";
import type { JobStatus, ProjectProfile, TapdContext, TapdIteration, TapdWorkspace, TaskMode } from "../types";
import { createUniqueId } from "../utils/uniqueId";
import { ChangePassword, Login } from "./WorkHoursPage";
import { StatusBadge } from "./StatusBadge";
import "../styles/workbench.css";
import "../styles/workbench-sessions.css";

interface WorkItem {
  id: string;
  title: string;
  description: string;
  source: "manual" | "tapd";
  projectId: string;
  taskMode: TaskMode;
  conversationId: string;
  createdAt: string;
  workspaceId?: string;
  iterationId?: string;
  parentTitle?: string;
  parentUrl?: string;
  tapdStatus?: string;
  tapdUrl?: string;
  tapdContext?: TapdContext;
  itemType?: "task" | "bug";
  businessProject?: string;
}

const businessProjects = ["村财项目", "产权项目", "支付中台"];
const monorepoProjectId = "b2b-composite";
const tapdStatusLabels: Record<string, string> = {
  open: "未开始", progressing: "进行中", done: "已完成",
  new: "新建", in_progress: "接受/处理", resolved: "已解决",
  verified: "已验证", reopened: "重新打开", rejected: "已拒绝", closed: "已关闭",
};
const tapdStatusLabel = (status?: string) => status ? tapdStatusLabels[status.toLowerCase()] || status : "TAPD 未返回状态";
type View = "work" | "manual" | "tests";
const needsAttention = (job?: JobStatus) => Boolean(job && ["awaiting_input", "awaiting_confirm", "awaiting_merge", "failed"].includes(job.status));
const isOwner = (owner: string | undefined, name: string) => Boolean(name.trim() && owner?.split(/[;,，；|]/).some((part) => part.trim() === name.trim()));
const errorText = (error: unknown) => error instanceof Error ? error.message : "读取失败，请重试";

function MyWorkbench({ user, onLogout }: { user: AuthUser; onLogout: () => void }) {
  const { message } = AntApp.useApp();
  const storageKey = `ai-runtime:workbench:${user.id}`;
  const [saved, setSaved] = useState<WorkItem[]>(() => {
    try {
      const value: unknown = JSON.parse(localStorage.getItem(storageKey) || "[]");
      return Array.isArray(value) ? value.filter((item): item is WorkItem => Boolean(item && typeof item.id === "string" && typeof item.title === "string" && typeof item.conversationId === "string" && typeof item.projectId === "string" && ["manual", "tapd"].includes(item.source))) : [];
    } catch { return []; }
  });
  const [view, setView] = useState<View>("work");
  const [workType, setWorkType] = useState<"all" | "task" | "bug">("all");
  const [search, setSearch] = useState("");
  const [layout, setLayout] = useState<"board" | "list">("board");
  const [statusFilter, setStatusFilter] = useState<string>();
  const [expandedProjects, setExpandedProjects] = useState<string[]>([]);
  const [projects, setProjects] = useState<ProjectProfile[]>([]);
  const [businessProject, setBusinessProject] = useState<string>(businessProjects[0]);
  const [workspaces, setWorkspaces] = useState<TapdWorkspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState<string>();
  const [iterations, setIterations] = useState<TapdIteration[]>([]);
  const [iterationId, setIterationId] = useState<string>();
  const [remoteItems, setRemoteItems] = useState<WorkItem[]>([]);
  const [jobs, setJobs] = useState<JobStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [tapdLoading, setTapdLoading] = useState(false);
  const [tapdError, setTapdError] = useState("");
  const [runtimeError, setRuntimeError] = useState("");
  const [projectError, setProjectError] = useState("");
  const [revision, setRevision] = useState(0);
  const [creating, setCreating] = useState(false);
  const [launch, setLaunch] = useState<WorkbenchTaskLaunch>();
  const [opening, setOpening] = useState<string>();
  const openingRef = useRef(false);
  const [form] = Form.useForm();

  const persist = (items: WorkItem[]) => {
    try { localStorage.setItem(storageKey, JSON.stringify(items)); setSaved(items); return true; }
    catch { message.error("任务保存失败，请检查浏览器存储空间"); return false; }
  };

  useEffect(() => {
    let current = true;
    api.listProjects().then((items) => { if (current) { setProjects(items); setProjectError(""); } }).catch((error) => { if (current) setProjectError(errorText(error)); });
    api.tapdWorkspaces().then((result) => {
      if (current) { setWorkspaces(result.workspaces); setWorkspaceId(result.defaultWorkspaceId || result.workspaces[0]?.id); }
    }).catch((error) => { if (current) setTapdError(errorText(error)); });
    return () => { current = false; };
  }, [revision]);

  useEffect(() => {
    let current = true;
    const refresh = () => api.listJobs().then((items) => { if (current) { setJobs(items); setRuntimeError(""); } })
      .catch((error) => { if (current) setRuntimeError(errorText(error)); }).finally(() => { if (current) setLoading(false); });
    void refresh();
    const timer = window.setInterval(() => void refresh(), 10_000);
    return () => { current = false; window.clearInterval(timer); };
  }, [revision, launch]);

  useEffect(() => {
    let current = true;
    setIterations([]); setIterationId(undefined); setRemoteItems([]);
    if (workspaceId) {
      setTapdLoading(true);
      api.tapdIterations(workspaceId).then((result) => {
        if (!current) return;
        setIterations(result.iterations);
        setIterationId(result.iterations.find((item) => /^(open|running|active|进行中)$/i.test(item.status || ""))?.id || result.iterations[0]?.id);
        setTapdError("");
      }).catch((error) => { if (current) setTapdError(errorText(error)); }).finally(() => { if (current) setTapdLoading(false); });
    }
    return () => { current = false; };
  }, [workspaceId, revision]);

  useEffect(() => {
    const workspace = workspaces.find((item) => item.id === workspaceId);
    const name = workspace?.pretty_name || workspace?.name || "";
    const matched = businessProjects.find((item) => name.includes(item.replace(/项目$/, "")));
    if (matched) setBusinessProject(matched);
  }, [workspaceId, workspaces]);

  useEffect(() => {
    let current = true;
    setRemoteItems([]);
    if (workspaceId && iterationId && user.tapdOwnerName.trim()) {
      setTapdLoading(true);
      Promise.allSettled([api.tapdIterationItems(workspaceId, iterationId), api.tapdIterationBugs(workspaceId, iterationId)]).then(([taskResult, bugResult]) => {
        if (!current) return;
        const items: WorkItem[] = [];
        const append = (item: { id: string; name: string; status?: string }, type: "task" | "bug", parentTitle?: string, parentId?: string) => {
          items.push({ id: `${workspaceId}:${type}:${item.id}`, title: item.name, description: "", source: "tapd", itemType: type, projectId: "", taskMode: "code", conversationId: "", createdAt: "", workspaceId, iterationId, parentTitle, parentUrl: parentId ? `https://www.tapd.cn/${workspaceId}/stories/view/${parentId}` : undefined, tapdStatus: item.status, tapdUrl: `https://www.tapd.cn/${workspaceId}/${type === "task" ? "tasks" : "bugs"}/view/${item.id}` });
        };
        if (taskResult.status === "fulfilled") {
          taskResult.value.stories.forEach((story) => {
            story.tasks.filter((task) => isOwner(task.owner, user.tapdOwnerName)).forEach((task) => append(task, "task", story.name, story.id));
          });
          taskResult.value.orphanTasks.filter((task) => isOwner(task.owner, user.tapdOwnerName)).forEach((task) => append(task, "task"));
        }
        if (bugResult.status === "fulfilled") {
          bugResult.value.bugs.filter((bug) => isOwner(bug.owner, user.tapdOwnerName)).forEach((bug) => append(bug, "bug"));
        }
        setRemoteItems(items);
        setTapdError([taskResult.status === "rejected" ? `任务读取失败：${errorText(taskResult.reason)}` : "", bugResult.status === "rejected" ? `Bug 读取失败：${errorText(bugResult.reason)}` : ""].filter(Boolean).join("；"));
      }).catch((error) => { if (current) setTapdError(errorText(error)); }).finally(() => { if (current) setTapdLoading(false); });
    }
    return () => { current = false; };
  }, [workspaceId, iterationId, user.tapdOwnerName, revision]);

  const items = useMemo(() => {
    const merged = new Map(saved.filter((item) => item.source === "manual").map((item) => [item.id, item]));
    remoteItems.forEach((item) => {
      const existing = saved.find((entry) => entry.id === item.id);
      merged.set(item.id, existing ? { ...existing, title: item.title, itemType: item.itemType, tapdStatus: item.tapdStatus, parentTitle: item.parentTitle, parentUrl: item.parentUrl } : item);
    });
    return [...merged.values()];
  }, [saved, remoteItems, workspaceId, iterationId]);
  const jobFor = (item: WorkItem) => jobs.filter((job) => item.conversationId && job.conversationId === item.conversationId && job.projectId === item.projectId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const visibleItems = items.filter((item) => view === "work" ? item.source === "tapd" : view === "tests" ? item.taskMode === "test-case" : item.source === "manual" && item.taskMode !== "test-case");
  const workStatus = (item: WorkItem) => {
    if (item.source === "tapd") {
      const sync = jobFor(item)?.tapdSync;
      return sync?.state === "synced" ? tapdStatusLabel(sync.target) : tapdStatusLabel(item.tapdStatus);
    }
    const status = jobFor(item)?.status;
    if (!status) return "未开始";
    if (["planning", "pending", "running"].includes(status)) return "执行中";
    if (["awaiting_input", "awaiting_confirm", "awaiting_merge"].includes(status)) return "待处理";
    return status === "completed" ? "已完成" : status === "failed" ? "失败" : "已取消";
  };
  const needsSupplement = (job?: JobStatus) => Boolean(job && !job.workbenchReset && !job.workbenchPauseRequested && job.status === "awaiting_input" && (job.workbenchNeedsInput === true || (job.workbenchNeedsInput === undefined && (Boolean(job.clarificationQuestions?.length) || /等待.*(?:回复|补充|澄清)/.test(job.message || "")))));
  const boardStatus = (item: WorkItem) => {
    const job = jobFor(item);
    if (!job) return workStatus(item);
    if (job.workbenchReset) return "未开始";
    if (job.workbenchPauseRequested) return "已停止";
    if (job.status === "completed" && job.tapdSync?.target === "done" && job.tapdSync.state !== "synced") return "待同步";
    if (job.status === "awaiting_merge" && job.commitSha && job.commitSha !== job.workbenchBaseCommitSha && job.workbenchHasCodeChanges !== false) return "待审查";
    if (["awaiting_confirm", "awaiting_merge"].includes(job.status)) return "未开始";
    if (["planning", "pending", "running"].includes(job.status)) return "执行中";
    if (job.status === "awaiting_input") return needsSupplement(job) ? "执行中" : "未开始";
    if (job.status === "completed") return "已完成";
    return job.status === "failed" ? "执行中断" : "已停止";
  };
  const availableStatuses = [...new Set(visibleItems.map(boardStatus))];
  const filtered = visibleItems.filter((item) => (!search || `${item.title} ${item.parentTitle || ""}`.toLowerCase().includes(search.toLowerCase())) &&
    (view !== "work" || workType === "all" || item.itemType === workType) && (!statusFilter || boardStatus(item) === statusFilter));
  const titles: Record<View, string> = { work: "我的工作", manual: "我的任务", tests: "测试用例" };
  const laneOrder = ["未开始", "执行中", "待审查", "待同步", "已完成", "执行中断", "已停止"];
  const laneNames = [...new Set([...laneOrder.filter((name) => ["未开始", "执行中", "待审查", "已完成"].includes(name) || filtered.some((item) => boardStatus(item) === name)), ...filtered.map(boardStatus)])];
  const sidebarProjects = [...new Set(visibleItems.map((item) => item.businessProject || businessProject))];
  const listLoading = loading || (view === "work" && tapdLoading);
  const openCreate = () => {
    form.resetFields();
    form.setFieldsValue({ businessProject, taskMode: view === "tests" ? "test-case" : "code" });
    setCreating(true);
  };

  const openItem = async (item: WorkItem) => {
    if (openingRef.current) return;
    const job = jobFor(item);
    const projectId = job ? item.projectId : monorepoProjectId;
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
          if (storyId) requirementUrl = `https://www.tapd.cn/${item.workspaceId}/stories/view/${storyId}`;
        }
        if (!requirementUrl) throw new Error("该任务尚未关联 TAPD 需求，请先在 TAPD 关联需求后再开始任务");
        context = await api.resolveTapd(requirementUrl);
      } else if (item.tapdUrl && !job) {
        context = await api.resolveTapd(item.tapdUrl);
      }
      const workItem = { ...item, projectId, businessProject: selectedBusinessProject, conversationId: item.conversationId || createUniqueId(), tapdContext: context };
      if (!persist([...saved.filter((entry) => entry.id !== item.id), workItem])) return;
      const prompt = `${item.description || `请分析并实现：${item.title}${item.parentTitle ? `\n所属需求：${item.parentTitle}` : ""}`}\n\n所属业务项目：${selectedBusinessProject}。该业务项目位于 B2B 管理后台共享 monorepo，请定位对应业务模块后开展工作。`;
      const taskId = item.itemType === "task" ? item.tapdUrl?.split("/").pop() : undefined;
      setLaunch({ title: item.title, businessProject: selectedBusinessProject, conversationId: workItem.conversationId, projectId, prompt, taskMode: item.taskMode, tapdContext: context, tapdTask: taskId && item.workspaceId ? { workspaceId: item.workspaceId, taskId } : undefined, jobId: job?.jobId });
    } catch (error) { message.error(errorText(error)); }
    finally { openingRef.current = false; setOpening(undefined); }
  };

  return <div className="workbench-shell">
    <aside className="workbench-nav">
      <a className="wb-brand" href="/workbench"><span className="wb-brand-symbol">a<span>i</span></span><strong>ai-runtime</strong><span className="wb-beta">工作台</span></a>
      <Button className="wb-new" aria-label="新建任务" icon={<PlusOutlined />} onClick={openCreate}>新建任务</Button>
      <div className="wb-nav-caption">工作空间</div>
      <nav aria-label="工作台导航">
        {([
          ["work", <InboxOutlined />, "我的工作"], ["manual", <CodeOutlined />, "我的任务"], ["tests", <ExperimentOutlined />, "测试用例"],
        ] as const).map(([key, icon, label]) => <button key={key} aria-label={label} className={`wb-nav-item${view === key && !launch ? " is-selected" : ""}`} onClick={() => { setLaunch(undefined); setView(key); setSearch(""); setStatusFilter(undefined); setWorkType("all"); }} aria-current={view === key && !launch ? "page" : undefined}>{icon}<span>{label}</span></button>)}
      </nav>
      <div className="wb-project-heading">项目 <span>{sidebarProjects.length}</span></div>
      <div className="wb-sidebar-sessions">
        {sidebarProjects.map((name) => <section className="wb-sidebar-project" key={name}>
          <button className="wb-project-toggle" aria-expanded={expandedProjects.includes(name)} onClick={() => setExpandedProjects((current) => current.includes(name) ? current.filter((entry) => entry !== name) : [...current, name])}>{name}<DownOutlined /></button>
          {expandedProjects.includes(name) && visibleItems.filter((item) => (item.businessProject || businessProject) === name).map((item) => <button className={`wb-sidebar-session${launch?.conversationId && launch.conversationId === item.conversationId ? " is-current" : ""}`} key={item.id} aria-label={`打开任务：${item.title}`} onClick={() => void openItem(item)} disabled={Boolean(opening)}><span>{item.title}</span><small>{item.itemType === "bug" ? <BugOutlined /> : <CodeOutlined />}{workStatus(item)}</small></button>)}
        </section>)}
        {!sidebarProjects.length && <p className="wb-sidebar-empty">任务将在这里按项目展示</p>}
      </div>
      <div className="wb-nav-bottom">
        <a href="/"><ArrowLeftOutlined /> 返回原工作台</a>
        <div className="wb-account"><span className="wb-avatar">{(user.displayName || user.username).slice(0, 1)}</span><div><strong>{user.displayName || user.username}</strong><small>{user.tapdOwnerName || "尚未绑定 TAPD"}</small></div><Button type="text" icon={<LogoutOutlined />} aria-label="退出登录" onClick={onLogout} /></div>
      </div>
    </aside>

    <section className="wb-main">
      <header className="wb-topbar"><div className="wb-page-title"><Button type="text" icon={<ArrowLeftOutlined />} aria-label={launch ? "返回任务列表" : "返回原工作台"} onClick={() => launch ? setLaunch(undefined) : window.location.assign("/")} /><h1>{launch ? launch.title : titles[view]}</h1></div><a href="/work-hours">填写工时 <ArrowRightOutlined /></a></header>
      {launch ? <div className="wb-execution-wrap"><WorkbenchSession key={launch.conversationId} task={launch} onChanged={() => setRevision(value => value + 1)} /></div> :
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
          {view === "work" && <><Select aria-label="TAPD 项目" placeholder="TAPD 项目" value={workspaceId} onChange={setWorkspaceId} options={workspaces.map((item) => ({ value: item.id, label: item.pretty_name || item.name || item.id }))} />
          <Select aria-label="迭代" placeholder="选择迭代" value={iterationId} onChange={setIterationId} loading={tapdLoading} options={iterations.map((item) => ({ value: item.id, label: item.name }))} /></>}
          <Select aria-label="业务项目" placeholder="业务项目" value={businessProject} onChange={setBusinessProject} options={businessProjects.map((name) => ({ value: name, label: name }))} />
          {view === "work" && <div className="wb-work-types" role="group" aria-label="工作类型">{([["all", "全部"], ["task", "任务"], ["bug", "Bug"]] as const).map(([value, label]) => <button key={value} aria-label={label} aria-pressed={workType === value} onClick={() => setWorkType(value)}>{label}</button>)}</div>}
          <Button type="text" className="wb-clear-filters" onClick={() => { setSearch(""); setStatusFilter(undefined); setWorkType("all"); }}>清除筛选</Button>
        </div>
        {(runtimeError || projectError) && <Alert type="error" showIcon message={runtimeError || projectError} action={<Button onClick={() => setRevision((value) => value + 1)}>重试</Button>} />}
        {view === "work" && !user.tapdOwnerName.trim() && <Alert type="info" showIcon message="请在账号管理中绑定 TAPD 处理人。" />}
        {view === "work" && tapdError && <Alert type="warning" showIcon message={tapdError} />}
        <div className="wb-session-results" aria-busy={listLoading}>
          {listLoading ? <div className="wb-empty"><Spin tip="正在读取任务"><div style={{ padding: 32 }} /></Spin></div> : filtered.length === 0 ? <div className="wb-empty"><Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={search || statusFilter ? "没有匹配的任务" : "这里还没有任务"} /><p>{view === "work" ? "选择项目与迭代，读取自己的 TAPD 任务和 Bug。" : view === "tests" ? "新建测试用例任务后，生成结果会显示在这里。" : "新建任务，开始一次需求分析或代码修改。"}</p>{view !== "work" && <Button icon={<PlusOutlined />} onClick={openCreate}>{view === "tests" ? "生成测试用例" : "新建任务"}</Button>}</div> : layout === "board" ? (
            <div className="wb-board">{laneNames.map((name) => {
              const laneItems = filtered.filter((item) => boardStatus(item) === name);
              return <section className="wb-board-lane" key={name} aria-label={name}>
                <header><span className={["已完成", "已解决", "已关闭", "已验证"].includes(name) ? "wb-lane-done" : ""}>{["已完成", "已解决", "已关闭", "已验证"].includes(name) ? <CheckOutlined /> : <UnorderedListOutlined />}{name === "待审查" ? "待审查（Review）" : name} <small>{laneItems.length}</small></span></header>
                {laneItems.map((item) => {
                  const job = jobFor(item);
                  return <article className="wb-board-card" key={item.id} onClick={() => void openItem(item)} aria-busy={opening === item.id}>
                    <div className="wb-card-project">{item.businessProject || businessProject}{needsSupplement(job) && <Tag className="wb-supplement-tag" color="orange">待补充</Tag>}</div>
                    <button className="wb-task-title" disabled={Boolean(opening)}>{item.title}</button>
                    {job && ["planning", "pending", "running"].includes(job.status) && <i className="wb-card-live" aria-label="AI 正在执行" />}
                    <div className="wb-card-footer">{item.itemType === "bug" ? <BugOutlined /> : item.taskMode === "test-case" ? <ExperimentOutlined /> : <CodeOutlined />}<span>{opening === item.id ? "正在读取需求…" : job ? `${item.source === "tapd" ? "TAPD · " + workStatus(item) + " · " : ""}${job.message || (needsAttention(job) ? "等待你处理" : "查看执行进展")}` : item.source === "tapd" ? "TAPD · " + workStatus(item) : "尚未开始执行"}</span>{item.tapdUrl && <a href={item.tapdUrl} aria-label="在 TAPD 查看" target="_blank" rel="noreferrer" onClick={(event) => event.stopPropagation()}>↗</a>}</div>
                  </article>;
                })}
              </section>;
            })}</div>
          ) : <div className="wb-task-list">{filtered.map((item) => {
            const job = jobFor(item);
          return <article className="wb-task-row" key={item.id}><span className={`wb-task-icon ${item.source}`}>{item.itemType === "bug" ? <BugOutlined /> : item.source === "tapd" ? <UnorderedListOutlined /> : item.taskMode === "test-case" ? <ExperimentOutlined /> : <CodeOutlined />}</span><div className="wb-task-text"><button className="wb-task-title" disabled={Boolean(opening)} onClick={() => void openItem(item)}>{item.title}</button><div className="wb-task-meta">{needsSupplement(job) && <Tag className="wb-supplement-tag" color="orange">执行中 · 待补充</Tag>}<span>{item.source === "tapd" ? item.itemType === "bug" ? "TAPD · Bug" : "TAPD · 任务" : "手动创建"}</span><span>{item.businessProject || (item.source === "tapd" ? businessProject : "未选择业务项目")}</span>{item.tapdUrl && <a href={item.tapdUrl} target="_blank" rel="noreferrer">查看 TAPD ↗</a>}</div>{item.source === "tapd" && job && <div className="wb-task-progress">AI 执行：<StatusBadge status={job.status} /></div>}{job?.message && <p className="wb-task-progress">{job.message}</p>}</div><div className="wb-task-actions">{item.source === "tapd" ? <Tag>{tapdStatusLabel(item.tapdStatus)}</Tag> : job ? <StatusBadge status={job.status} /> : <Tag>待开始</Tag>}<Button size="small" loading={opening === item.id} disabled={Boolean(opening) && opening !== item.id} onClick={() => void openItem(item)}>{job ? needsAttention(job) ? "去处理" : "查看执行" : "开始任务"}<ArrowRightOutlined /></Button></div></article>;
          })}</div>}
        </div>
        <div className="wb-session-footnote">{filtered.length} 项 · {view === "work" ? "工作状态来自 TAPD" : "手动任务保存在当前浏览器"}{view === "tests" ? " · 自动化执行将在后续版本提供" : ""}</div>
      </main>}
    </section>

    <Modal title="新建任务" open={creating} onCancel={() => setCreating(false)} footer={null} forceRender>
      <Form form={form} layout="vertical" initialValues={{ taskMode: view === "tests" ? "test-case" : "code", businessProject: businessProjects[0] }} onFinish={(values: { title: string; description: string; businessProject: string; taskMode: TaskMode }) => {
        const title = values.title.trim();
        if (!title) { message.error("请输入任务名称"); return; }
        if (!projects.some((project) => project.id === monorepoProjectId)) { message.error("B2B 管理后台仓库尚未配置"); return; }
        const item: WorkItem = { id: createUniqueId(), title, description: `${title}\n\n${values.description || ""}`.trim(), source: "manual", projectId: monorepoProjectId, businessProject: values.businessProject, taskMode: values.taskMode, conversationId: createUniqueId(), createdAt: new Date().toISOString() };
        if (persist([item, ...saved])) { setCreating(false); setLaunch(undefined); setSearch(""); setView(values.taskMode === "test-case" ? "tests" : "manual"); message.success("任务已创建，选择开始任务进入需求分析"); }
      }}>
        <Form.Item name="title" label="任务名称" rules={[{ required: true, whitespace: true }]}><Input placeholder="例如：修复登录页验证码失效" maxLength={200} /></Form.Item>
        <Form.Item name="description" label="需求描述与验收条件"><Input.TextArea rows={5} placeholder="描述要完成什么、问题如何复现，以及预期结果…" /></Form.Item>
        <Form.Item name="businessProject" label="业务项目" rules={[{ required: true }]}><Select options={businessProjects.map((name) => ({ value: name, label: name }))} /></Form.Item>
        <Form.Item name="taskMode" label="任务类型"><Select options={[{ value: "code", label: "开发 / Bug 修复" }, { value: "test-case", label: "生成测试用例" }, { value: "question", label: "分析与问答" }]} /></Form.Item>
        <Button type="primary" htmlType="submit" block>创建任务</Button>
      </Form>
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
