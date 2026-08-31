import { App as AntApp, Button, Input, Modal, Select, Space, Tooltip, Typography } from "antd";
import { BellOutlined, ReloadOutlined, SafetyCertificateOutlined } from "@ant-design/icons";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ConversationPanel } from "./components/ConversationPanel";
import { TaskComposer } from "./components/TaskComposer";
import { TaskDetailPanel } from "./components/TaskDetailPanel";
import { TaskSidebar } from "./components/TaskSidebar";
import { api, openJobStream } from "./services/api";
import { useTaskStore } from "./stores/taskStore";
import type { AgentProvider, JobStatus, TapdContext, TapdImageOption, TapdIteration, TapdWorkspace } from "./types";
import { compressImage } from "./utils/imageCompress";
import {
  getDesktopNotificationPermission,
  requestDesktopNotificationPermission,
  showDesktopNotification,
  type DesktopNotificationPermission,
} from "./utils/desktopNotification";
import { startTitleAlert, stopTitleAlert } from "./utils/titleAlert";
import { createUniqueId } from "./utils/uniqueId";

const terminalStatuses = new Set(["completed", "failed", "cancelled", "awaiting_confirm", "awaiting_input", "awaiting_merge"]);

function newConversationId(): string {
  return createUniqueId();
}

function revokeTapdPreviews(images: TapdImageOption[]): void {
  images.forEach((image) => URL.revokeObjectURL(image.previewUrl));
}

export default function App() {
  const { message, modal } = AntApp.useApp();
  const store = useTaskStore();
  const [draft, setDraft] = useState("");
  const [modifyCode, setModifyCode] = useState(true);
  const [agentProvider, setAgentProvider] = useState<AgentProvider>("claude");
  const [files, setFiles] = useState<File[]>([]);
  const [conversationId, setConversationId] = useState(newConversationId);
  const [tapdContext, setTapdContext] = useState<TapdContext>();
  const [tapdImages, setTapdImages] = useState<TapdImageOption[]>([]);
  const [busy, setBusy] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [tapdOpen, setTapdOpen] = useState(false);
  const [tapdUrl, setTapdUrl] = useState("");
  const [tapdLoading, setTapdLoading] = useState(false);
  const [resolvedTapd, setResolvedTapd] = useState<TapdContext>();
  const [tapdCandidates, setTapdCandidates] = useState<TapdImageOption[]>([]);
  const [releaseOpen, setReleaseOpen] = useState(false);
  const [releaseBranches, setReleaseBranches] = useState<string[]>([]);
  const [releaseBranch, setReleaseBranch] = useState<string>();
  const [releaseJobIds, setReleaseJobIds] = useState<string[]>([]);
  const [bugOpen, setBugOpen] = useState(false);
  const [workspaces, setWorkspaces] = useState<TapdWorkspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState<string>();
  const [iterations, setIterations] = useState<TapdIteration[]>([]);
  const [iterationId, setIterationId] = useState<string>();
  const [createMergeRequest] = useState(
    () => localStorage.getItem("createMergeRequestOnMerge") === "true"
  );
  const [planDrafts, setPlanDrafts] = useState<Record<string, string>>({});
  const [notificationPermission, setNotificationPermission] = useState<DesktopNotificationPermission>(
    getDesktopNotificationPermission
  );
  const knownJobStatuses = useRef(new Map<string, JobStatus["status"]>());

  const notifyJobStatus = useCallback((job: JobStatus) => {
    let body: string | undefined;
    let requireInteraction = false;
    switch (job.status) {
      case "awaiting_confirm":
        body = "Plan 已生成，等待执行修改";
        requireInteraction = true;
        break;
      case "awaiting_input":
        body = "Plan 需要补充信息";
        requireInteraction = true;
        break;
      case "awaiting_merge":
        body = job.mergeRetryable
          ? "Git 仓库不可用，等待重试合并"
          : "代码修改完成，等待合并确认";
        requireInteraction = true;
        break;
      case "completed":
        body = job.mergedToDefaultBranch
          ? "代码修改并合并成功"
          : job.requiresConfirm
            ? "代码修改已完成"
            : "项目问答已完成";
        break;
      case "failed":
        body = job.error ? `任务执行失败：${job.error.slice(0, 120)}` : "任务执行失败";
        requireInteraction = true;
        break;
    }
    if (!body) return;
    startTitleAlert(body);
    showDesktopNotification({
      body,
      tag: `ai-runtime-${job.jobId}-${job.status}`,
      requireInteraction,
      onClick: () => useTaskStore.getState().selectJob(job.jobId),
    });
  }, []);

  const applyJobUpdate = useCallback((job: JobStatus) => {
    const previous = knownJobStatuses.current.get(job.jobId);
    knownJobStatuses.current.set(job.jobId, job.status);
    store.upsertJob(job);
    if (previous && previous !== job.status) notifyJobStatus(job);
  }, [notifyJobStatus, store]);

  const enableDesktopNotifications = useCallback(async (announce = true) => {
    const permission = await requestDesktopNotificationPermission();
    setNotificationPermission(permission);
    if (!announce) return;
    if (permission === "granted") {
      message.success("桌面通知已开启");
    } else if (permission === "denied") {
      message.info("桌面通知已被浏览器阻止，将使用标签标题滚动提醒");
    } else {
      message.info("局域网 HTTP 已自动使用标签标题滚动提醒");
    }
  }, [message]);

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") stopTitleAlert();
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      stopTitleAlert();
    };
  }, []);

  const selectedJob = useMemo(
    () => store.jobs.find((job) => job.jobId === store.selectedJobId),
    [store.jobs, store.selectedJobId]
  );
  const selectedEvents = store.selectedJobId ? store.events[store.selectedJobId] ?? [] : [];
  const conversationJobs = useMemo(() => {
    if (!selectedJob) return [];
    const key = selectedJob.conversationId || selectedJob.jobId;
    return store.jobs
      .filter((job) => (job.conversationId || job.jobId) === key)
      .sort((left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime());
  }, [selectedJob, store.jobs]);

  const refreshJobs = useCallback(async (keepSelection = true) => {
    try {
      const jobs = await api.listJobs();
      const visibleIds = new Set(jobs.map((job) => job.jobId));
      for (const jobId of knownJobStatuses.current.keys()) {
        if (!visibleIds.has(jobId)) knownJobStatuses.current.delete(jobId);
      }
      for (const job of jobs) {
        const previous = knownJobStatuses.current.get(job.jobId);
        knownJobStatuses.current.set(job.jobId, job.status);
        if (previous && previous !== job.status) notifyJobStatus(job);
      }
      store.setJobs(jobs);
      if (!keepSelection && jobs[0]) store.selectJob(jobs[0].jobId);
    } catch (error) {
      message.error(error instanceof Error ? error.message : "任务列表加载失败");
    }
  }, [message, notifyJobStatus, store]);

  const refreshJob = useCallback(async (jobId: string) => {
    try {
      applyJobUpdate(await api.getJob(jobId));
    } catch {
      // A cancelled or restarted in-memory task may no longer exist.
    }
  }, [applyJobUpdate]);

  useEffect(() => {
    store.setLoading(true);
    void Promise.all([
      refreshJobs(false),
      api.getClient().then((client) => store.setRemoteIp(client.remoteIp)).catch(() => store.setRemoteIp("服务未连接")),
    ]).finally(() => store.setLoading(false));
    const timer = window.setInterval(() => void refreshJobs(), 10_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const jobId = store.selectedJobId;
    if (!jobId) return;
    const currentState = useTaskStore.getState();
    const currentJob = currentState.jobs.find((job) => job.jobId === jobId);
    const conversationKey = currentJob?.conversationId || jobId;
    const relatedJobs = currentState.jobs.filter((job) => (job.conversationId || job.jobId) === conversationKey);
    void Promise.all([
      ...relatedJobs.map((job) => api.getEvents(job.jobId).then((events) => store.setEvents(job.jobId, events))),
      refreshJob(jobId),
    ]);
    const source = openJobStream(jobId, (event) => {
      store.appendEvent(event);
      if (
        event.type === "done" ||
        event.type === "error" ||
        event.type === "cancelled" ||
        event.phase?.includes("done") ||
        event.phase === "plan_need_more" ||
        event.phase === "execute_ready" ||
        event.phase === "merge_retryable"
      ) {
        void refreshJob(jobId);
      }
    });
    return () => source.close();
  }, [store.selectedJobId]);

  useEffect(() => {
    if (selectedJob?.conversationId) setConversationId(selectedJob.conversationId);
  }, [selectedJob?.conversationId]);

  const selectJob = (jobId: string) => store.selectJob(jobId);
  const startNew = () => {
    store.selectJob(undefined);
    setConversationId(newConversationId());
    setDraft("");
    setFiles([]);
    setTapdContext(undefined);
    revokeTapdPreviews(tapdImages);
    setTapdImages([]);
  };

  const deleteConversation = (targetConversationId: string, title: string) => modal.confirm({
    title: "确认删除这条任务记录？",
    content: `“${title}”将从当前终端的列表中删除，同时清理附件和执行事件；已经推送的代码不会被撤回。`,
    okText: "确认删除",
    okButtonProps: { danger: true },
    cancelText: "取消",
    onOk: async () => {
      try {
        await api.deleteConversation(targetConversationId);
        const selected = useTaskStore.getState().jobs.find((job) => job.jobId === useTaskStore.getState().selectedJobId);
        if (selected && (selected.conversationId || selected.jobId) === targetConversationId) startNew();
        await refreshJobs();
        message.success("任务记录已删除");
      } catch (error) {
        message.error(error instanceof Error ? error.message : "任务删除失败");
        throw error;
      }
    },
  });

  const submit = async () => {
    const prompt = draft.trim();
    if (!prompt || submitting) return;
    if (notificationPermission === "default") void enableDesktopNotifications(false);
    setSubmitting(true);
    try {
      const uploadSources = [...tapdImages.map((item) => item.blob), ...files];
      const compressed = await Promise.all(uploadSources.map(compressImage));
      const submittedTapdContext = tapdContext
        ? {
            ...tapdContext,
            attachedImageCount: tapdImages.length,
            attachedImageIndexes: tapdImages.map((item) => item.sourceIndex),
          }
        : undefined;
      const result = await api.submit({
        prompt,
        conversationId,
        agentProvider,
        tapdContext: submittedTapdContext,
        images: compressed,
        imageNames: [
          ...tapdImages.map((item) => `tapd-description-${item.sourceIndex}.webp`),
          ...files.map((file, index) => `${file.name.replace(/\.[^.]+$/, "") || `screenshot-${index + 1}`}.webp`),
        ],
      }, modifyCode);
      setDraft("");
      setFiles([]);
      setTapdContext(undefined);
      revokeTapdPreviews(tapdImages);
      setTapdImages([]);
      await refreshJobs();
      store.selectJob(result.jobId);
      message.success(modifyCode ? "已开始生成修改方案" : "已开始分析项目");
    } catch (error) {
      message.error(error instanceof Error ? error.message : "提交失败");
    } finally {
      setSubmitting(false);
    }
  };

  const runAction = async (action: () => Promise<unknown>, success: string) => {
    if (!selectedJob || busy) return;
    setBusy(true);
    try {
      await action();
      message.success(success);
      await api.getEvents(selectedJob.jobId)
        .then((events) => store.setEvents(selectedJob.jobId, events))
        .catch(() => undefined);
      await refreshJob(selectedJob.jobId);
      await refreshJobs();
    } catch (error) {
      message.error(error instanceof Error ? error.message : "操作失败");
    } finally {
      setBusy(false);
    }
  };

  const confirmExecute = (planSummary: string) => {
    if (notificationPermission === "default") void enableDesktopNotifications(false);
    return runAction(async () => {
      const jobId = selectedJob!.jobId;
      await api.execute(jobId, planSummary);
      setPlanDrafts((current) => {
        const next = { ...current };
        delete next[jobId];
        return next;
      });
    }, "已按编辑后的方案开始执行代码修改");
  };
  const cancelJob = () => modal.confirm({
    title: "确认取消当前任务？",
    content: "正在执行的 Agent 进程和临时工作区将被停止并清理。",
    okText: "确认取消",
    okButtonProps: { danger: true },
    cancelText: "继续执行",
    onOk: () => runAction(() => api.cancel(selectedJob!.jobId), "任务已取消"),
  });
  const mergeJob = () => runAction(() => api.merge(selectedJob!.jobId, createMergeRequest), createMergeRequest ? "正在创建 Merge Request" : "正在合并代码");
  const discardMerge = () => modal.confirm({
    title: "放弃本次合并？",
    content: "任务分支和未合并改动将被清理。",
    okText: "确认放弃",
    okButtonProps: { danger: true },
    onOk: () => runAction(() => api.discardMerge(selectedJob!.jobId), "已放弃合并"),
  });
  const revertJob = () => modal.confirm({
    title: "确认撤回默认分支提交？",
    content: "系统会创建新的 revert commit 并推送，不影响已合并的其他分支。",
    okText: "确认撤回",
    okButtonProps: { danger: true },
    onOk: () => runAction(() => api.revert(selectedJob!.jobId), "撤回完成"),
  });

  const resolveTapd = async () => {
    if (!tapdUrl.trim()) return;
    setTapdLoading(true);
    try {
      const context = await api.resolveTapd(tapdUrl.trim());
      const candidates = await api.tapdDescriptionImages(context);
      const availableSlots = Math.max(0, 3 - files.length);
      const withSelection = candidates.map((item, index) => ({ ...item, selected: index < availableSlots }));
      if (withSelection.length === 0) {
        setTapdContext(context);
        revokeTapdPreviews(tapdImages);
        setTapdImages([]);
        setTapdOpen(false);
        setTapdUrl("");
        message.success("已关联 TAPD 条目");
      } else {
        setResolvedTapd(context);
        setTapdCandidates(withSelection);
      }
    } catch (error) {
      message.error(error instanceof Error ? error.message : "TAPD 条目读取失败");
    } finally {
      setTapdLoading(false);
    }
  };

  const confirmTapdImages = () => {
    if (!resolvedTapd) return;
    const selected = tapdCandidates.filter((item) => item.selected);
    revokeTapdPreviews(tapdImages);
    revokeTapdPreviews(tapdCandidates.filter((item) => !item.selected));
    setTapdContext(resolvedTapd);
    setTapdImages(selected);
    setTapdOpen(false);
    setTapdUrl("");
    setResolvedTapd(undefined);
    setTapdCandidates([]);
    message.success(`已关联 TAPD 条目${selected.length ? `及 ${selected.length} 张配图` : ""}`);
  };

  const toggleTapdImage = (sourceIndex: number) => {
    setTapdCandidates((current) => {
      const selectedCount = current.filter((item) => item.selected).length;
      return current.map((item) => {
        if (item.sourceIndex !== sourceIndex) return item;
        if (!item.selected && selectedCount + files.length >= 3) {
          message.warning("TAPD 配图和手动截图合计最多 3 张");
          return item;
        }
        return { ...item, selected: !item.selected };
      });
    });
  };

  const openRelease = async (jobIds?: string[]) => {
    const targetIds = jobIds?.length ? jobIds : selectedJob ? [selectedJob.jobId] : [];
    if (targetIds.length === 0) return;
    setBusy(true);
    try {
      const branchLists = await Promise.all(targetIds.map((jobId) => api.releaseBranches(jobId)));
      const commonBranches = branchLists.slice(1).reduce(
        (common, branches) => common.filter((branch) => branches.includes(branch)),
        branchLists[0] ?? []
      );
      if (commonBranches.length === 0) {
        message.warning("所选子任务没有共同可合并的目标分支");
        return;
      }
      setReleaseJobIds(targetIds);
      setReleaseBranches(commonBranches);
      setReleaseBranch(commonBranches[0]);
      setReleaseOpen(true);
    } catch (error) {
      message.error(error instanceof Error ? error.message : "分支列表读取失败");
    } finally {
      setBusy(false);
    }
  };

  const confirmReleaseMerge = async () => {
    if (!releaseBranch || releaseJobIds.length === 0 || busy) return;
    setBusy(true);
    try {
      const ordered = store.jobs
        .filter((job) => releaseJobIds.includes(job.jobId))
        .sort((left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime());
      for (const job of ordered) await api.mergeToRelease(job.jobId, releaseBranch);
      setReleaseOpen(false);
      await refreshJobs();
      await Promise.all(ordered.map((job) => api.getEvents(job.jobId).then((events) => store.setEvents(job.jobId, events)).catch(() => undefined)));
      message.success(ordered.length > 1 ? `已按顺序合并 ${ordered.length} 个子任务到 ${releaseBranch}` : `已合并到 ${releaseBranch}`);
    } catch (error) {
      message.error(error instanceof Error ? error.message : "分支合并失败");
    } finally {
      setBusy(false);
    }
  };

  const batchRevert = (jobIds: string[]) => modal.confirm({
    title: `确认撤回 ${jobIds.length} 个子任务？`,
    content: "系统会从最后一次修改开始倒序创建 revert commit 并推送，避免破坏子任务之间的依赖关系。",
    okText: "确认倒序撤回",
    okButtonProps: { danger: true },
    cancelText: "取消",
    onOk: async () => {
      if (busy) return;
      setBusy(true);
      try {
        const ordered = store.jobs
          .filter((job) => jobIds.includes(job.jobId))
          .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime());
        for (const job of ordered) await api.revert(job.jobId);
        await refreshJobs();
        await Promise.all(ordered.map((job) => api.getEvents(job.jobId).then((events) => store.setEvents(job.jobId, events)).catch(() => undefined)));
        message.success(`已倒序撤回 ${ordered.length} 个子任务`);
      } catch (error) {
        message.error(error instanceof Error ? error.message : "批量撤回失败");
        throw error;
      } finally {
        setBusy(false);
      }
    },
  });

  const openBug = async () => {
    try {
      const data = await api.tapdWorkspaces();
      setWorkspaces(data.workspaces);
      const selected = data.defaultWorkspaceId || data.workspaces[0]?.id;
      setWorkspaceId(selected);
      setBugOpen(true);
      if (selected) {
        const iterationData = await api.tapdIterations(selected);
        setIterations(iterationData.iterations);
        setIterationId(iterationData.iterations[0]?.id);
      }
    } catch (error) {
      message.error(error instanceof Error ? error.message : "TAPD 配置读取失败");
    }
  };

  const changeWorkspace = async (value: string) => {
    setWorkspaceId(value);
    setIterationId(undefined);
    const data = await api.tapdIterations(value);
    setIterations(data.iterations);
    setIterationId(data.iterations[0]?.id);
  };

  const active = selectedJob && !terminalStatuses.has(selectedJob.status);

  return (
    <div className="app-shell">
      <TaskSidebar
        jobs={store.jobs}
        selectedJobId={store.selectedJobId}
        loading={store.loading}
        onSelect={selectJob}
        onNew={startNew}
        onDelete={deleteConversation}
      />

      <section className="workspace-main">
        <header className="workspace-header">
          <div>
            <Typography.Title level={4}>{selectedJob?.prompt || "新建任务"}</Typography.Title>
            <Typography.Text type="secondary">{selectedJob ? `Job ${selectedJob.jobId.slice(0, 8)}` : "在下方输入问题或修改需求"}</Typography.Text>
          </div>
          <Space>
            {active && <span className="live-indicator"><i /> 实时连接</span>}
            <Tooltip title={
              notificationPermission === "granted"
                ? "桌面通知已开启"
                : notificationPermission === "unsupported"
                  ? "局域网 HTTP 已启用标题滚动提醒"
                  : "开启桌面通知"
            }>
              <Button
                type={notificationPermission === "granted" ? "primary" : "text"}
                icon={<BellOutlined />}
                onClick={() => void enableDesktopNotifications()}
              />
            </Tooltip>
            <Tooltip title="刷新任务"><Button type="text" icon={<ReloadOutlined />} onClick={() => void refreshJobs()} /></Tooltip>
          </Space>
        </header>

        <main className="conversation-scroll">
          <ConversationPanel
            jobs={conversationJobs}
            currentJob={selectedJob}
            modifyCode={modifyCode}
            eventsByJob={store.events}
            planDrafts={planDrafts}
            busy={busy}
            onModifyCodeChange={setModifyCode}
            onPlanChange={(jobId, value) => setPlanDrafts((current) => ({ ...current, [jobId]: value }))}
            onExecute={confirmExecute}
          />
        </main>

        <footer className="workspace-composer">
          <TaskComposer
            value={draft}
            modifyCode={modifyCode}
            agentProvider={agentProvider}
            files={files}
            tapdContext={tapdContext}
            tapdImages={tapdImages}
            submitting={submitting}
            onChange={setDraft}
            onModifyCodeChange={setModifyCode}
            onAgentProviderChange={setAgentProvider}
            onFilesChange={setFiles}
            onOpenTapd={() => setTapdOpen(true)}
            onRemoveTapd={() => {
              setTapdContext(undefined);
              revokeTapdPreviews(tapdImages);
              setTapdImages([]);
            }}
            onSubmit={() => void submit()}
          />
        </footer>
      </section>

      <TaskDetailPanel
        job={selectedJob}
        jobs={conversationJobs}
        events={selectedEvents}
        busy={busy}
        onCancel={cancelJob}
        onMerge={mergeJob}
        onDiscard={discardMerge}
        onRelease={() => void openRelease()}
        onRevert={revertJob}
        onTapdBug={() => void openBug()}
        onSelectJob={selectJob}
        onBatchRelease={(jobIds) => void openRelease(jobIds)}
        onBatchRevert={batchRevert}
      />

      <div className="client-corner">
        <SafetyCertificateOutlined /> 当前终端 {store.remoteIp || "识别中"}
      </div>

      <Modal
        title="关联 TAPD 条目"
        open={tapdOpen}
        onCancel={() => {
          setTapdOpen(false);
          setResolvedTapd(undefined);
          revokeTapdPreviews(tapdCandidates);
          setTapdCandidates([]);
        }}
        onOk={() => resolvedTapd ? confirmTapdImages() : void resolveTapd()}
        okText={resolvedTapd ? "确认关联" : "读取条目"}
        cancelText="取消"
        confirmLoading={tapdLoading}
      >
        {!resolvedTapd ? (
          <>
            <Typography.Paragraph type="secondary">粘贴需求、任务或缺陷链接，条目内容会作为当前会话上下文。</Typography.Paragraph>
            <Input value={tapdUrl} onChange={(event) => setTapdUrl(event.target.value)} placeholder="https://www.tapd.cn/..." onPressEnter={() => void resolveTapd()} />
          </>
        ) : (
          <>
            <Typography.Paragraph strong>{resolvedTapd.title}</Typography.Paragraph>
            <Typography.Paragraph type="secondary">选择随任务发送的描述配图。与手动截图合计最多 3 张。</Typography.Paragraph>
            <div className="tapd-image-grid">
              {tapdCandidates.map((item) => (
                <button
                  type="button"
                  key={item.sourceIndex}
                  className={`tapd-image-option${item.selected ? " is-selected" : ""}`}
                  onClick={() => toggleTapdImage(item.sourceIndex)}
                >
                  <img src={item.previewUrl} alt={`TAPD 配图${item.sourceIndex}`} />
                  <span>配图{item.sourceIndex}</span>
                </button>
              ))}
            </div>
          </>
        )}
      </Modal>

      <Modal
        title={releaseJobIds.length > 1 ? `顺序合并 ${releaseJobIds.length} 个子任务` : "合并到其他分支"}
        open={releaseOpen}
        onCancel={() => setReleaseOpen(false)}
        okText="确认合并"
        okButtonProps={{ disabled: !releaseBranch }}
        confirmLoading={busy}
        onOk={() => void confirmReleaseMerge()}
      >
        {releaseJobIds.length > 1 && <Typography.Paragraph type="secondary">将按第 1 次到最后一次的顺序应用提交。</Typography.Paragraph>}
        <Select style={{ width: "100%" }} value={releaseBranch} options={releaseBranches.map((branch) => ({ label: branch, value: branch }))} onChange={setReleaseBranch} placeholder="选择目标分支" />
      </Modal>

      <Modal
        title="提交 TAPD Bug"
        open={bugOpen}
        onCancel={() => setBugOpen(false)}
        okText="提交 Bug"
        okButtonProps={{ disabled: !workspaceId || !iterationId }}
        confirmLoading={busy}
        onOk={() => void runAction(async () => {
          await api.createTapdBug({
            title: selectedJob!.prompt?.slice(0, 100) || "AI Runtime 任务",
            description: selectedJob!.planSummary || selectedJob!.message || "",
            workspaceId: workspaceId!,
            iterationId: iterationId!,
          });
          setBugOpen(false);
        }, "TAPD Bug 创建成功")}
      >
        <Space direction="vertical" style={{ width: "100%" }}>
          <Select style={{ width: "100%" }} value={workspaceId} options={workspaces.map((item) => ({ label: item.name || item.pretty_name || item.id, value: item.id }))} onChange={(value) => void changeWorkspace(value)} placeholder="选择项目" />
          <Select style={{ width: "100%" }} value={iterationId} options={iterations.map((item) => ({ label: item.name, value: item.id }))} onChange={setIterationId} placeholder="选择迭代" />
        </Space>
      </Modal>
    </div>
  );
}
