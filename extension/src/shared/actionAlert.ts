let actionAlertTitle = "";
let actionAlertNotificationId: string | null = null;

interface ActionAlertOptions {
  title: string;
}

export function stopActionAlert(): void {
  actionAlertTitle = "";
  // 清理旧版本可能遗留的闪烁 badge，后续提醒只使用桌面通知。
  void chrome.action.setBadgeText({ text: "" });
  void chrome.action.setTitle({ title: "AI Runtime" });
  if (actionAlertNotificationId) {
    void chrome.notifications.clear(actionAlertNotificationId);
    actionAlertNotificationId = null;
  }
}

export function startActionAlert(options: ActionAlertOptions): void {
  if (actionAlertNotificationId && actionAlertTitle === options.title) {
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
}

export function isActionAlertNotification(notificationId: string): boolean {
  return notificationId === actionAlertNotificationId;
}
