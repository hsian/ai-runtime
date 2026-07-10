let actionAlertTimer: ReturnType<typeof setInterval> | null = null;
let actionAlertVisible = false;
let actionAlertTitle = "";
let actionAlertNotificationId: string | null = null;

interface ActionAlertOptions {
  title: string;
}

function setActionBadge(text: string): void {
  void chrome.action.setBadgeBackgroundColor({ color: "#f97316" });
  void chrome.action.setBadgeTextColor?.({ color: "#ffffff" });
  void chrome.action.setBadgeText({ text });
}

export function stopActionAlert(): void {
  if (actionAlertTimer) {
    clearInterval(actionAlertTimer);
    actionAlertTimer = null;
  }
  actionAlertVisible = false;
  actionAlertTitle = "";
  void chrome.action.setBadgeText({ text: "" });
  void chrome.action.setTitle({ title: "AI Runtime" });
  if (actionAlertNotificationId) {
    void chrome.notifications.clear(actionAlertNotificationId);
    actionAlertNotificationId = null;
  }
}

export function startActionAlert(options: ActionAlertOptions): void {
  if (actionAlertTimer && actionAlertTitle === options.title) {
    return;
  }

  stopActionAlert();
  actionAlertTitle = options.title;
  void chrome.action.setTitle({ title: options.title });
  actionAlertNotificationId = `ai-runtime-alert-${Date.now()}`;
  void chrome.notifications.create(actionAlertNotificationId, {
    type: "basic",
    iconUrl: "icons/icon128.png",
    title: "AI Runtime",
    message: options.title,
    priority: 2,
  });

  const tick = (): void => {
    actionAlertVisible = !actionAlertVisible;
    setActionBadge(actionAlertVisible ? "OK" : "");
  };

  tick();
  actionAlertTimer = setInterval(tick, 650);
}

export function isActionAlertNotification(notificationId: string): boolean {
  return notificationId === actionAlertNotificationId;
}
