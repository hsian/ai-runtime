import "./requirement.css";
import { loadConfig } from "../shared/config.js";
import {
  cancelAnalyzeRequirement,
  fetchAnalyzeEvents,
  fetchAnalyzeSession,
  fetchTapdRequirement,
  openAnalyzeEventStream,
  startAnalyzeRequirement,
} from "../shared/requirementApi.js";
import { formatErrorMessage, isNotFoundError } from "../shared/api.js";
import { formatPolishedRequirementText } from "../shared/requirementFormat.js";
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
let analyzePollTimer: ReturnType<typeof setInterval> | null = null;
let elapsedTimer: ReturnType<typeof setInterval> | null = null;
let analyzeStartedAt = 0;
let progressLogLines: string[] = [];
let progressLastLabel = "整理中…";
let isPageUnloading = false;
let lastStreamErrorLoggedAt = 0;
const seenAnalyzeEventIds = new Set<string>();

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
  el<HTMLTextAreaElement>("reqRawPreview").value = requirement.contentText;
}

function syncRequirementFromEditor(): void {
  if (!currentRequirement) return;
  currentRequirement = {
    ...currentRequirement,
    contentText: el<HTMLTextAreaElement>("reqRawPreview").value,
  };
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
  progressLastLabel = "整理中…";
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
  analyzeBtn.textContent = active ? "取消整理" : "开始整理";
  analyzeBtn.classList.toggle("req-cancel-btn", active);
  el<HTMLButtonElement>("reqSaveBtn").disabled = active;
  el<HTMLButtonElement>("reqRefreshBtn").disabled = active;
  el<HTMLTextAreaElement>("reqRawPreview").disabled = active;
}

function closeAnalyzeStream(): void {
  if (analyzeStream) {
    analyzeStream.close();
    analyzeStream = null;
  }
}

function stopAnalyzePoll(): void {
  if (analyzePollTimer) {
    clearInterval(analyzePollTimer);
    analyzePollTimer = null;
  }
}

function resetAnalyzeTracking(): void {
  seenAnalyzeEventIds.clear();
  lastStreamErrorLoggedAt = 0;
}

function dispatchAnalyzeEvent(event: AnalyzeEvent): void {
  if (seenAnalyzeEventIds.has(event.id)) return;
  seenAnalyzeEventIds.add(event.id);
  handleAnalyzeEvent(event);
}

async function persistPageState(): Promise<void> {
  syncRequirementFromEditor();
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

function isInvalidRequirementDraft(text: string | undefined): boolean {
  const trimmed = (text ?? "").trim();
  if (!trimmed) return true;
  return /Claude Code 已完成|已完成代码修改|Plan 分析完成/i.test(trimmed);
}

function sanitizeRequirementDraft(draftPrompt?: string): string | undefined {
  if (isInvalidRequirementDraft(draftPrompt)) return undefined;
  return formatPolishedRequirementText(draftPrompt!);
}

async function finishAnalyze(
  message: string,
  draftPrompt?: string,
  options?: { keepProgress?: boolean }
): Promise<void> {
  stopElapsedTimer();
  stopAnalyzePoll();
  closeAnalyzeStream();
  resetAnalyzeTracking();
  activeSessionId = null;
  activeServerUrl = "";
  setAnalyzing(false);
  if (!options?.keepProgress) {
    showAnalyzeProgress(false);
  }
  setStatus(message);

  if (draftPrompt) {
    const safe = sanitizeRequirementDraft(draftPrompt);
    if (safe) {
      el<HTMLTextAreaElement>("reqDraftPrompt").value = safe;
    }
  }

  await saveRequirementPageState({
    requirement: currentRequirement,
    draftPrompt: el<HTMLTextAreaElement>("reqDraftPrompt").value,
    analyzeSession: null,
  });
}

async function releaseAnalyzeSession(message: string): Promise<void> {
  appendProgressLog(message);
  await finishAnalyze(message, undefined, { keepProgress: true });
}

function updateProgressLabel(text: string, appendLog = false): void {
  progressLastLabel = text;
  el<HTMLElement>("reqProgressLabel").textContent = text;
  setStatus(text);
  if (appendLog) {
    appendProgressLog(text);
  }
  void persistPageState();
}

function handleAnalyzeEvent(event: AnalyzeEvent): void {
  if (event.type === "stage" && event.text) {
    updateProgressLabel(event.text, true);
    return;
  }

  if (event.type === "agent_text" && event.delta) {
    const draft = el<HTMLTextAreaElement>("reqDraftPrompt");
    draft.value += event.delta;
    void persistPageState();
    return;
  }

  if (event.type === "agent_tool" && event.text) {
    updateProgressLabel(event.text, true);
    return;
  }

  if (event.type === "done") {
    const draft = sanitizeRequirementDraft(event.draftPrompt);
    if (!draft) {
      appendProgressLog("✗ 整理失败：返回了无效内容，请重试");
      void finishAnalyze("整理失败：未获得有效文字（请勿与编码模式混淆），请重试");
      return;
    }
    appendProgressLog("✓ 整理完成");
    void finishAnalyze("整理完成，请核实或修改后加入任务", draft);
    return;
  }

  if (event.type === "cancelled") {
    appendProgressLog("已取消");
    void finishAnalyze("整理已取消");
    return;
  }

  if (event.type === "error") {
    const message = event.text ?? event.message ?? "整理失败";
    appendProgressLog(`✗ ${message}`);
    void finishAnalyze(message);
  }
}

async function pollAnalyzeProgress(serverUrl: string, sessionId: string): Promise<void> {
  if (activeSessionId !== sessionId) return;

  try {
    const events = await fetchAnalyzeEvents(serverUrl, sessionId);
    for (const event of events) {
      dispatchAnalyzeEvent(event);
      if (activeSessionId !== sessionId) return;
    }

    const status = await fetchAnalyzeSession(serverUrl, sessionId);
    if (activeSessionId !== sessionId) return;

    if (status.status === "completed") {
      const draft = sanitizeRequirementDraft(status.draftPrompt);
      if (!draft) {
        await finishAnalyze("整理失败：未获得有效文字，请重试");
        return;
      }
      await finishAnalyze("整理完成，请核实或修改后加入任务", draft);
      return;
    }
    if (status.status === "cancelled") {
      await finishAnalyze("整理已取消");
      return;
    }
    if (status.status === "failed") {
      await finishAnalyze(status.error ?? status.message ?? "整理失败");
      return;
    }

    if (status.message && status.message !== progressLastLabel) {
      updateProgressLabel(status.message, false);
    }
  } catch (err) {
    if (isNotFoundError(err)) {
      await releaseAnalyzeSession("整理任务已不存在（服务端可能已重启），请点击「开始整理」重试");
    }
  }
}

function startAnalyzePoll(serverUrl: string, sessionId: string): void {
  stopAnalyzePoll();
  void pollAnalyzeProgress(serverUrl, sessionId);
  analyzePollTimer = setInterval(() => {
    void pollAnalyzeProgress(serverUrl, sessionId);
  }, 4000);
}

function connectAnalyzeStream(serverUrl: string, sessionId: string): void {
  closeAnalyzeStream();

  analyzeStream = openAnalyzeEventStream(serverUrl, sessionId, dispatchAnalyzeEvent, {
    onError: () => {
      if (isPageUnloading || activeSessionId !== sessionId) return;
      const now = Date.now();
      if (now - lastStreamErrorLoggedAt < 15_000) return;
      lastStreamErrorLoggedAt = now;
      appendProgressLog("实时连接不稳定，已改用轮询同步进度…");
    },
  });
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
      const draft = sanitizeRequirementDraft(status.draftPrompt);
      if (!draft) {
        await finishAnalyze("整理失败：未获得有效文字，请重试");
        return;
      }
      await finishAnalyze("整理已完成（离开期间完成）", draft);
      return;
    }

    if (status.status === "cancelled") {
      await finishAnalyze("整理已取消");
      return;
    }

    if (status.status === "failed") {
      await finishAnalyze(status.error ?? status.message ?? "整理失败");
      return;
    }

    activeSessionId = session.sessionId;
    activeServerUrl = serverUrl;
    progressLogLines = [...session.progressLog];
    progressLastLabel = session.lastLabel ?? "整理进行中…";

    showAnalyzeProgress(true);
    setAnalyzing(true);
    renderProgressLog(progressLogLines);
    el<HTMLElement>("reqProgressLabel").textContent = progressLastLabel;
    startElapsedTimer(session.startedAt);
    setStatus("整理进行中，已恢复进度…");

    resetAnalyzeTracking();
    const events = await fetchAnalyzeEvents(serverUrl, session.sessionId);
    for (const event of events) {
      seenAnalyzeEventIds.add(event.id);
    }

    startAnalyzePoll(serverUrl, session.sessionId);
    connectAnalyzeStream(serverUrl, session.sessionId);
  } catch (err) {
    await clearAnalyzeSessionState();
    await releaseAnalyzeSession("整理任务已过期或不存在，请点击「开始整理」重试");
  }
}

function restorePageState(state: RequirementPageState): void {
  if (state.requirement) {
    currentRequirement = state.requirement;
    renderRequirement(state.requirement);
  }
  el<HTMLTextAreaElement>("reqDraftPrompt").value = formatPolishedRequirementText(state.draftPrompt);
}

async function loadTapdRequirement(): Promise<void> {
  if (activeSessionId) {
    setStatus("整理进行中，请先取消整理再刷新");
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
      imageBlobs.length > 0 ? `，已提取 ${imageBlobs.length} 张配图（整理时会发给 AI）` : "";
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
  setStatus("正在取消整理…");
  el<HTMLButtonElement>("reqAnalyzeBtn").disabled = true;

  try {
    if (serverUrl) {
      await cancelAnalyzeRequirement(serverUrl, sessionId);
      appendProgressLog("取消请求已发送");
      await finishAnalyze("整理已取消");
    }
  } catch (err) {
    if (isNotFoundError(err)) {
      await releaseAnalyzeSession("整理任务已不存在，已重置；请点击「开始整理」重试");
    } else {
      setStatus(formatErrorMessage(serverUrl, err));
    }
  } finally {
    el<HTMLButtonElement>("reqAnalyzeBtn").disabled = false;
    setAnalyzing(Boolean(activeSessionId));
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

  syncRequirementFromEditor();
  const rawContent = currentRequirement.contentText.trim();
  if (!rawContent) {
    setStatus("需求内容为空，请填写或重新读取 TAPD");
    return;
  }

  const config = await loadConfig();
  if (!config.serverUrl) {
    setStatus("请先在设置中配置服务端地址");
    return;
  }

  resetProgressLog();
  resetAnalyzeTracking();
  el<HTMLTextAreaElement>("reqDraftPrompt").value = "";
  showAnalyzeProgress(true);
  setAnalyzing(true);
  startElapsedTimer();
  activeServerUrl = config.serverUrl;

  const imageNote =
    currentImageBlobs.length > 0
      ? `正在上传并整理（含 ${currentImageBlobs.length} 张配图）…`
      : "正在提交整理任务…";
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
      // TAPD 页可能已关闭，继续纯文本整理
    }
  }

  try {
    const { sessionId } = await startAnalyzeRequirement(config.serverUrl, {
      title: currentRequirement.title,
      tapdUrl: currentRequirement.url,
      rawContent,
      images: currentImageBlobs.length > 0 ? currentImageBlobs : undefined,
    });

    activeSessionId = sessionId;
    await persistPageState();
    appendProgressLog("整理任务已提交，等待 AI 响应…");

    startAnalyzePoll(config.serverUrl, sessionId);
    connectAnalyzeStream(config.serverUrl, sessionId);
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
    setStatus("请先整理或填写任务描述");
    return;
  }

  syncRequirementFromEditor();

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
  el<HTMLTextAreaElement>("reqRawPreview").addEventListener("input", () => {
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
