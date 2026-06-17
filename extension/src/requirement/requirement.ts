import "./requirement.css";
import { loadConfig } from "../shared/config.js";
import { analyzeRequirement, fetchTapdRequirement } from "../shared/requirementApi.js";
import { formatErrorMessage } from "../shared/api.js";
import {
  createRequirementTask,
  saveRequirementTask,
} from "../shared/requirementStore.js";
import type { TapdRequirement } from "../shared/types.js";

let currentRequirement: TapdRequirement | null = null;

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

async function loadTapdRequirement(): Promise<void> {
  setStatus("正在读取 TAPD…");
  try {
    const requirement = await fetchTapdRequirement();
    currentRequirement = requirement;
    renderRequirement(requirement);
    setStatus("已读取 TAPD 需求");
  } catch (err) {
    setStatus(err instanceof Error ? err.message : "读取失败");
  }
}

async function handleAnalyze(): Promise<void> {
  if (!currentRequirement) {
    setStatus("请先读取 TAPD 需求（打开 TAPD 详情页后点刷新）");
    return;
  }

  const config = await loadConfig();
  if (!config.serverUrl) {
    setStatus("请先在设置中配置服务端地址");
    return;
  }

  const analyzeBtn = el<HTMLButtonElement>("reqAnalyzeBtn");
  analyzeBtn.disabled = true;
  setStatus("AI 正在分析需求…");

  try {
    const result = await analyzeRequirement(config.serverUrl, {
      title: currentRequirement.title,
      tapdUrl: currentRequirement.url,
      rawContent: currentRequirement.contentText,
    });
    el<HTMLTextAreaElement>("reqDraftPrompt").value = result.draftPrompt;
    setStatus("分析完成，请核实或修改后加入任务");
  } catch (err) {
    setStatus(formatErrorMessage(config.serverUrl, err));
  } finally {
    analyzeBtn.disabled = false;
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

function init(): void {
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

  void loadTapdRequirement();
}

init();
