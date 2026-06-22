import type { PageContext } from "../shared/types.js";
import { handleTapdBatchCommand, initTapdBatchControllerFromStorage } from "../shared/tapdBatchController.js";
import type { TapdBatchCommand } from "../shared/tapdBatchMessages.js";

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

async function getAnchorBrowserWindow(): Promise<chrome.windows.Window | undefined> {
  const windows = await chrome.windows.getAll({ windowTypes: ["normal"] });
  const focused = windows.find((w) => w.focused);
  if (focused) return focused;

  if (lastBrowserTabId !== null) {
    try {
      const tab = await chrome.tabs.get(lastBrowserTabId);
      return windows.find((w) => w.id === tab.windowId);
    } catch {
      // tab closed
    }
  }

  return windows[0];
}

async function getScreenCenterPopupBounds(
  anchor: chrome.windows.Window | undefined
): Promise<{ left: number; top: number; width: number; height: number }> {
  const width = 750;
  const height = 600;

  const displays = await chrome.system.display.getInfo();
  let display = displays.find((d) => d.isPrimary) ?? displays[0];

  if (anchor?.left !== undefined && anchor.top !== undefined) {
    const centerX = anchor.left + (anchor.width ?? 0) / 2;
    const centerY = anchor.top + (anchor.height ?? 0) / 2;
    const onDisplay = displays.find((d) => {
      const area = d.workArea;
      return (
        centerX >= area.left &&
        centerX < area.left + area.width &&
        centerY >= area.top &&
        centerY < area.top + area.height
      );
    });
    if (onDisplay) display = onDisplay;
  }

  const area = display?.workArea ?? { left: 0, top: 0, width: width, height: height };
  return {
    width,
    height,
    left: Math.round(area.left + (area.width - width) / 2),
    top: Math.round(area.top + (area.height - height) / 2),
  };
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

  const anchor = await getAnchorBrowserWindow();
  const bounds = await getScreenCenterPopupBounds(anchor);

  await chrome.windows.create({
    url: "app.html",
    type: "popup",
    focused: true,
    ...bounds,
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

void initTapdBatchControllerFromStorage();

chrome.action.onClicked.addListener(() => {
  void openAppWindow();
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type?.startsWith("TAPD_BATCH_")) {
    void handleTapdBatchCommand(message as TapdBatchCommand).then(sendResponse);
    return true;
  }

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
});
