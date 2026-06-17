import type { PageContext } from "../shared/types.js";
import {
  extractTapdRequirementInPage,
  isTapdUrl,
  TAPD_TAB_URL_PATTERNS,
  type TapdExtractResult,
} from "../shared/tapdPageExtract.js";

let lastBrowserTabId: number | null = null;

function isBrowserTab(tab: chrome.tabs.Tab): boolean {
  const url = tab.url ?? "";
  return url.startsWith("http://") || url.startsWith("https://");
}

async function rememberTab(tabId: number): Promise<void> {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (isBrowserTab(tab)) {
      lastBrowserTabId = tabId;
    }
  } catch {
    // tab closed
  }
}

async function captureFocusedBrowserTab(): Promise<void> {
  const windows = await chrome.windows.getAll({ populate: true, windowTypes: ["normal"] });
  const focused = windows.find((w) => w.focused) ?? windows[0];
  const tab = focused?.tabs?.find((t) => t.active && isBrowserTab(t));
  if (tab?.id) {
    lastBrowserTabId = tab.id;
  }
}

async function getTargetTab(): Promise<chrome.tabs.Tab | undefined> {
  if (lastBrowserTabId !== null) {
    try {
      const tab = await chrome.tabs.get(lastBrowserTabId);
      if (isBrowserTab(tab)) return tab;
    } catch {
      lastBrowserTabId = null;
    }
  }

  const windows = await chrome.windows.getAll({ populate: true, windowTypes: ["normal"] });
  const focused = windows.find((w) => w.focused) ?? windows[0];
  return focused?.tabs?.find((t) => t.active && isBrowserTab(t));
}

async function findTapdTab(): Promise<chrome.tabs.Tab | undefined> {
  if (lastBrowserTabId !== null) {
    try {
      const tab = await chrome.tabs.get(lastBrowserTabId);
      if (isBrowserTab(tab) && isTapdUrl(tab.url)) return tab;
    } catch {
      lastBrowserTabId = null;
    }
  }

  let tapdTabs = await chrome.tabs.query({ url: TAPD_TAB_URL_PATTERNS });
  if (tapdTabs.length === 0) {
    const allTabs = await chrome.tabs.query({});
    tapdTabs = allTabs.filter((tab) => isTapdUrl(tab.url));
  }
  if (tapdTabs.length === 0) return undefined;

  const activeTab = tapdTabs.find((tab) => tab.active);
  if (activeTab) return activeTab;

  const windows = await chrome.windows.getAll({ populate: true, windowTypes: ["normal"] });
  const focusedWindow = windows.find((w) => w.focused) ?? windows[0];
  if (focusedWindow?.id !== undefined) {
    const inFocusedWindow = tapdTabs.find(
      (tab) => tab.windowId === focusedWindow.id && tab.active
    );
    if (inFocusedWindow) return inFocusedWindow;

    const anyInFocusedWindow = tapdTabs.find((tab) => tab.windowId === focusedWindow.id);
    if (anyInFocusedWindow) return anyInFocusedWindow;
  }

  return tapdTabs.sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0))[0];
}

async function readTapdFromTab(tabId: number): Promise<TapdExtractResult> {
  try {
    const response = (await chrome.tabs.sendMessage(tabId, {
      type: "GET_TAPD_REQUIREMENT",
    })) as TapdExtractResult | undefined;
    if (response && typeof response === "object") {
      return response;
    }
  } catch {
    // content script 可能未注入（页面打开早于插件安装、或 SPA 未刷新）
  }

  try {
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId },
      func: extractTapdRequirementInPage,
    });
    if (injection?.result && typeof injection.result === "object") {
      return injection.result as TapdExtractResult;
    }
    return { ok: false, error: "读取 TAPD 需求失败：页面未返回有效内容" };
  } catch {
    return {
      ok: false,
      error: "无法读取 TAPD 页面，请刷新 TAPD 需求页后重试",
    };
  }
}

async function readPageContext(tabId: number): Promise<PageContext> {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: "GET_PAGE_CONTEXT" });
    return response as PageContext;
  } catch {
    const tab = await chrome.tabs.get(tabId);
    return {
      url: tab.url ?? "",
      title: tab.title ?? "",
      viewport: { width: 0, height: 0 },
    };
  }
}

async function openAppWindow(): Promise<void> {
  await captureFocusedBrowserTab();

  const appUrl = chrome.runtime.getURL("app.html");
  const windows = await chrome.windows.getAll({ populate: true });

  for (const win of windows) {
    const hasApp = win.tabs?.some((tab) => tab.url === appUrl);
    if (hasApp && win.id !== undefined) {
      await chrome.windows.update(win.id, { focused: true });
      const appTab = win.tabs?.find((tab) => tab.url === appUrl);
      if (appTab?.id) {
        await chrome.tabs.update(appTab.id, { active: true });
      }
      return;
    }
  }

  await chrome.windows.create({
    url: "app.html",
    type: "popup",
    width: 640,
    height: 600,
    focused: true,
  });
}

chrome.tabs.onActivated.addListener(({ tabId }) => {
  void rememberTab(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (tab.active && (changeInfo.url || changeInfo.status === "complete")) {
    void rememberTab(tabId);
  }
});

chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  void chrome.windows.get(windowId, { populate: true }, (win) => {
    if (win.type !== "normal") return;
    const tab = win.tabs?.find((t) => t.active);
    if (tab?.id) void rememberTab(tab.id);
  });
});

chrome.runtime.onInstalled.addListener(() => {
  console.log("[AI Runtime] Extension installed");
});

chrome.action.onClicked.addListener(() => {
  void openAppWindow();
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "GET_PAGE_CONTEXT") {
    void (async () => {
      await captureFocusedBrowserTab();
      const tab = await getTargetTab();
      if (!tab?.id) {
        sendResponse({ ok: false, error: "未找到可访问的浏览器页面，请先打开测试页面" });
        return;
      }
      const data = await readPageContext(tab.id);
      sendResponse({ ok: true, data });
    })();
    return true;
  }

  if (message.type === "GET_TAB_PREVIEW") {
    void (async () => {
      const tab = await getTargetTab();
      if (!tab?.id) {
        sendResponse({ ok: false, error: "未找到浏览器页面" });
        return;
      }
      sendResponse({
        ok: true,
        data: {
          url: tab.url ?? "",
          title: tab.title ?? "",
          viewport: { width: 0, height: 0 },
        },
      });
    })();
    return true;
  }

  if (message.type === "GET_TAPD_REQUIREMENT") {
    void (async () => {
      const tab = await findTapdTab();
      if (!tab?.id) {
        sendResponse({
          ok: false,
          error: "未找到 TAPD 页面，请先在浏览器打开 TAPD 需求详情页",
        });
        return;
      }

      const response = await readTapdFromTab(tab.id);
      if (!response.ok) {
        sendResponse({ ok: false, error: response.error ?? "读取 TAPD 需求失败" });
        return;
      }
      sendResponse({ ok: true, data: response.data });
    })();
    return true;
  }
});
