import "./requirement.css";
import { loadConfig } from "../shared/config.js";
import {
  cancelAnalyzeRequirement,
  fetchAnalyzeSession,
  fetchTapdRequirement,
  openAnalyzeEventStream,
  startAnalyzeRequirement,
} from "../shared/requirementApi.js";
import { formatErrorMessage } from "../shared/api.js";
import {
  clearAnalyzeSessionState,
  loadRequirementPageState,
  saveRequirementPageState,
  type RequirementPageState,
  type StoredAnalyzeSession,
} from "../shared/requirementPageStore.js";
import {
  createRequirementTask,
  saveRequirementTask,
} from "../shared/requirementStore.js";
import type { AnalyzeEvent, TapdRequirement } from "../shared/types.js";

let currentRequirement: TapdRequirement | null = null;
let currentImageBlobs: Blob[] = [];
let activeSessionId: string | null = null;
let activeServerUrl = "";
let analyzeStream: EventSource | null = null;
let elapsedTimer: ReturnType<typeof setInterval> | null = null;
let analyzeStartedAt = 0;
let progressLogLines: string[] = [];
let progressLastLabel = "分析中…";
let isPageUnloading = false;

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing #${id}`);
  return node as T;
}

function setStatus(text: string): void {
  el<HTMLElement>("reqStatus").textContent = text;
}

function renderRequirement(requirement: TapdRequirement): void {
  el<HTMLElement>("reqPageTitle").textContent = requirement.title;
  el<HTMLElement>("reqPageUrl").textContent = requirement.url;
  el<HTMLElement>("reqRawPreview").textContent = requirement.contentText;
}

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}m ${secs}s`;
}

function showAnalyzeProgress(show: boolean): void {
  el<HTMLElement>("reqAnalyzeProgress").classList.toggle("hidden", !show);
}

function renderProgressLog(lines: string[]): void {
  const log = el<HTMLElement>("reqProgressLog");
  log.innerHTML = "";
  for (const text of lines) {
    const line = document.createElement("div");
    line.className = "req-log-line";
    line.textContent = text;
    log.appendChild(line);
  }
  log.scrollTop = log.scrollHeight;
}

function appendProgressLog(text: string): void {
  progressLogLines.push(text);
  const log = el<HTMLElement>("reqProgressLog");
  const line = document.createElement("div");
  line.className = "req-log-line";
  line.textContent = text;
  log.appendChild(line);
  log.scrollTop = log.scrollHeight;
  void persistPageState();
}

function resetProgressLog(): void {
  progressLogLines = [];
  progressLastLabel = "分析中…";
  el<HTMLElement>("reqProgressLog").innerHTML = "";
  el<HTMLElement>("reqProgressLabel").textContent = progressLastLabel;
  el<HTMLElement>("reqProgressElapsed").textContent = "0s";
}

function startElapsedTimer(startedAt = Date.now()): void {
  stopElapsedTimer();
  analyzeStartedAt = startedAt;
  elapsedTimer = setInterval(() => {
    const seconds = Math.floor((Date.now() - analyzeStartedAt) / 1000);
    el<HTMLElement>("reqProgressElapsed").textContent = formatElapsed(seconds);
  }, 1000);
  const seconds = Math.floor((Date.now() - analyzeStartedAt) / 1000);
  el<HTMLElement>("reqProgressElapsed").textContent = formatElapsed(seconds);
}

function stopElapsedTimer(): void {
  if (elapsedTimer) {
    clearInterval(elapsedTimer);
    elapsedTimer = null;
  }
}

function setAnalyzing(active: boolean): void {
  const analyzeBtn = el<HTMLButtonElement>("reqAnalyzeBtn");
  analyzeBtn.textContent = active ? "取消分析" : "开始分析";
  analyzeBtn.classList.toggle("req-cancel-btn", active);
  el<HTMLButtonElement>("reqSaveBtn").disabled = active;
  el<HTMLButtonElement>("reqRefreshBtn").disabled = active;
}

function closeAnalyzeStream(): void {
  if (analyzeStream) {
    analyzeStream.close();
    analyzeStream = null;
  }
}

async function persistPageState(): Promise<void> {
  const analyzeSession: StoredAnalyzeSession | null = activeSessionId
    ? {
        sessionId: activeSessionId,
        serverUrl: activeServerUrl,
        startedAt: analyzeStartedAt,
        status: "running",
        progressLog: [...progressLogLines],
        lastLabel: progressLastLabel,
      }
    : null;

  await saveRequirementPageState({
    requirement: currentRequirement,
    draftPrompt: el<HTMLTextAreaElement>("reqDraftPrompt").value,
    analyzeSession,
  });
}

async function finishAnalyze(message: string, draftPrompt?: string): Promise<void> {
  stopElapsedTimer();
  closeAnalyzeStream();
  activeSessionId = null;
  activeServerUrl = "";
  setAnalyzing(false);
  showAnalyzeProgress(false);
  setStatus(message);

  if (draftPrompt) {
    el<HTMLTextAreaElement>("reqDraftPrompt").value = draftPrompt;
  }

  await saveRequirementPageState({
    requirement: currentRequirement,
    draftPrompt: el<HTMLTextAreaElement>("reqDraftPrompt").value,
    analyzeSession: null,
  });
}

function handleAnalyzeEvent(event: AnalyzeEvent): void {
  if (event.type === "stage" && event.text) {
    progressLastLabel = event.text;
    el<HTMLElement>("reqProgressLabel").textContent = event.text;
    appendProgressLog(event.text);
    setStatus(event.text);
    return;
  }

  if (event.type === "agent_tool" && event.text) {
    progressLastLabel = event.text;
    appendProgressLog(event.text);
    el<HTMLElement>("reqProgressLabel").textContent = event.text;
    return;
  }

  if (event.type === "done") {
    appendProgressLog("✓ 分析完成");
    void finishAnalyze("分析完成，请核实或修改后加入任务", event.draftPrompt);
    return;
  }

  if (event.type === "cancelled") {
    appendProgressLog("已取消");
    void finishAnalyze("分析已取消");
    return;
  }

  if (event.type === "error") {
    const message = event.text ?? event.message ?? "分析失败";
    appendProgressLog(`✗ ${message}`);
    void finishAnalyze(message);
  }
}

function connectAnalyzeStream(serverUrl: string, sessionId: string, replayFromScratch: boolean): void {
  closeAnalyzeStream();

  if (replayFromScratch) {
    progressLogLines = [];
    renderProgressLog([]);
  }

  analyzeStream = openAnalyzeEventStream(serverUrl, sessionId, handleAnalyzeEvent, {
    onClose: () => {
      if (isPageUnloading || activeSessionId !== sessionId) return;
      void verifySessionAfterDisconnect(serverUrl, sessionId);
    },
    onError: () => {
      if (isPageUnloading || activeSessionId !== sessionId) return;
      appendProgressLog("进度连接异常，正在检查分析状态…");
    },
  });
}

async function verifySessionAfterDisconnect(serverUrl: string, sessionId: string): Promise<void> {
  if (activeSessionId !== sessionId) return;

  try {
    const status = await fetchAnalyzeSession(serverUrl, sessionId);
    if (status.status === "completed" && status.draftPrompt) {
      await finishAnalyze("分析完成，请核实或修改后加入任务", status.draftPrompt);
      return;
    }
    if (status.status === "cancelled") {
      await finishAnalyze("分析已取消");
      return;
    }
    if (status.status === "failed") {
      await finishAnalyze(status.error ?? status.message ?? "分析失败");
      return;
    }
    if (status.status === "running") {
      appendProgressLog("连接已断开，分析仍在后台进行，正在重新连接…");
      connectAnalyzeStream(serverUrl, sessionId, true);
      setStatus("分析进行中，已重新连接进度…");
    }
  } catch {
    appendProgressLog("无法获取分析状态，请稍后重试或重新开始");
  }
}

async function resumeAnalyzeSession(session: StoredAnalyzeSession): Promise<void> {
  const config = await loadConfig();
  const serverUrl = session.serverUrl || config.serverUrl;
  if (!serverUrl) {
    await clearAnalyzeSessionState();
    setStatus("请先在设置中配置服务端地址");
    return;
  }

  try {
    const status = await fetchAnalyzeSession(serverUrl, session.sessionId);

    if (status.status === "completed") {
      await finishAnalyze("分析已完成（离开期间完成）", status.draftPrompt);
      return;
    }

    if (status.status === "cancelled") {
      await finishAnalyze("分析已取消");
      return;
    }

    if (status.status === "failed") {
      await finishAnalyze(status.error ?? status.message ?? "分析失败");
      return;
    }

    activeSessionId = session.sessionId;
    activeServerUrl = serverUrl;
    progressLogLines = [...session.progressLog];
    progressLastLabel = session.lastLabel ?? "分析进行中…";

    showAnalyzeProgress(true);
    setAnalyzing(true);
    renderProgressLog(progressLogLines);
    el<HTMLElement>("reqProgressLabel").textContent = progressLastLabel;
    startElapsedTimer(session.startedAt);
    setStatus("分析进行中，已恢复进度…");

    connectAnalyzeStream(serverUrl, session.sessionId, true);
  } catch {
    await clearAnalyzeSessionState();
    setStatus("分析任务已过期或不存在，请重新开始");
  }
}

function restorePageState(state: RequirementPageState): void {
  if (state.requirement) {
    currentRequirement = state.requirement;
    renderRequirement(state.requirement);
  }
  el<HTMLTextAreaElement>("reqDraftPrompt").value = state.draftPrompt;
}

async function loadTapdRequirement(): Promise<void> {
  if (activeSessionId) {
    setStatus("分析进行中，请先取消分析再刷新");
    return;
  }

  setStatus("正在读取 TAPD…");
  try {
    const { requirement, imageBlobs } = await fetchTapdRequirement();
    currentRequirement = requirement;
    currentImageBlobs = imageBlobs;
    renderRequirement(requirement);
    el<HTMLTextAreaElement>("reqDraftPrompt").value = "";
    const imageNote =
      imageBlobs.length > 0 ? `，已提取 ${imageBlobs.length} 张配图（分析时会发给 AI）` : "";
    setStatus(`已读取 TAPD 需求${imageNote}`);
    await persistPageState();
  } catch (err) {
    setStatus(err instanceof Error ? err.message : "读取失败");
  }
}

async function handleCancelAnalyze(): Promise<void> {
  if (!activeSessionId) return;

  const serverUrl = activeServerUrl || (await loadConfig()).serverUrl;
  const sessionId = activeSessionId;
  setStatus("正在取消分析…");
  el<HTMLButtonElement>("reqAnalyzeBtn").disabled = true;

  try {
    if (serverUrl) {
      await cancelAnalyzeRequirement(serverUrl, sessionId);
      appendProgressLog("取消请求已发送");
      await finishAnalyze("分析已取消");
    }
  } catch (err) {
    setStatus(formatErrorMessage(serverUrl, err));
  } finally {
    el<HTMLButtonElement>("reqAnalyzeBtn").disabled = false;
  }
}

async function handleAnalyze(): Promise<void> {
  if (activeSessionId) {
    await handleCancelAnalyze();
    return;
  }

  if (!currentRequirement) {
    setStatus("请先读取 TAPD 需求（打开 TAPD 详情页后点刷新）");
    return;
  }

  const config = await loadConfig();
  if (!config.serverUrl) {
    setStatus("请先在设置中配置服务端地址");
    return;
  }

  resetProgressLog();
  showAnalyzeProgress(true);
  setAnalyzing(true);
  startElapsedTimer();
  activeServerUrl = config.serverUrl;

  const imageNote =
    currentImageBlobs.length > 0
      ? `正在上传并分析（含 ${currentImageBlobs.length} 张配图）…`
      : "正在提交分析任务…";
  setStatus(imageNote);
  appendProgressLog(imageNote);

  if (currentImageBlobs.length === 0) {
    try {
      const { imageBlobs } = await fetchTapdRequirement();
      currentImageBlobs = imageBlobs;
      if (imageBlobs.length > 0) {
        appendProgressLog(`已重新提取 ${imageBlobs.length} 张配图`);
      }
    } catch {
      // TAPD 页可能已关闭，继续纯文本分析
    }
  }

  try {
    const { sessionId } = await startAnalyzeRequirement(config.serverUrl, {
      title: currentRequirement.title,
      tapdUrl: currentRequirement.url,
      rawContent: currentRequirement.contentText,
      images: currentImageBlobs.length > 0 ? currentImageBlobs : undefined,
    });

    activeSessionId = sessionId;
    await persistPageState();
    appendProgressLog("已连接进度流，等待 AI 响应…");

    connectAnalyzeStream(config.serverUrl, sessionId, false);
  } catch (err) {
    await finishAnalyze(formatErrorMessage(config.serverUrl, err));
  }
}

async function handleSave(): Promise<void> {
  if (!currentRequirement) {
    setStatus("请先读取 TAPD 需求");
    return;
  }

  const draftPrompt = el<HTMLTextAreaElement>("reqDraftPrompt").value.trim();
  if (!draftPrompt) {
    setStatus("请先分析或填写 prompt");
    return;
  }

  const saveBtn = el<HTMLButtonElement>("reqSaveBtn");
  saveBtn.disabled = true;

  try {
    const task = createRequirementTask({
      title: currentRequirement.title,
      tapdUrl: currentRequirement.url,
      rawContent: currentRequirement.contentText,
      draftPrompt,
    });
    await saveRequirementTask(task);
    setStatus(`已加入任务：${task.title}`);
    window.location.href = chrome.runtime.getURL("app.html");
  } catch (err) {
    setStatus(err instanceof Error ? err.message : "保存失败");
    saveBtn.disabled = false;
  }
}

async function init(): Promise<void> {
  el<HTMLAnchorElement>("backLink").href = chrome.runtime.getURL("app.html");
  el<HTMLButtonElement>("reqRefreshBtn").addEventListener("click", () => {
    void loadTapdRequirement();
  });
  el<HTMLButtonElement>("reqAnalyzeBtn").addEventListener("click", () => {
    void handleAnalyze();
  });
  el<HTMLButtonElement>("reqSaveBtn").addEventListener("click", () => {
    void handleSave();
  });

  el<HTMLTextAreaElement>("reqDraftPrompt").addEventListener("input", () => {
    void persistPageState();
  });

  window.addEventListener("pagehide", () => {
    isPageUnloading = true;
    void persistPageState();
  });

  const saved = await loadRequirementPageState();
  if (saved) {
    restorePageState(saved);
    if (saved.analyzeSession?.status === "running") {
      await resumeAnalyzeSession(saved.analyzeSession);
      return;
    }
    if (saved.requirement) {
      const imageNote = saved.draftPrompt ? "，已恢复上次编辑内容" : "";
      setStatus(`已恢复 TAPD 需求${imageNote}`);
      return;
    }
  }

  await loadTapdRequirement();
}

void init();
