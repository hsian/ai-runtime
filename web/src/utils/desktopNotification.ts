export type DesktopNotificationPermission = NotificationPermission | "unsupported";

export function getDesktopNotificationPermission(): DesktopNotificationPermission {
  if (!("Notification" in window) || !window.isSecureContext) return "unsupported";
  return Notification.permission;
}

export async function requestDesktopNotificationPermission(): Promise<DesktopNotificationPermission> {
  if (!("Notification" in window) || !window.isSecureContext) return "unsupported";
  if (Notification.permission !== "default") return Notification.permission;
  return Notification.requestPermission();
}

export function showDesktopNotification(options: {
  body: string;
  tag: string;
  requireInteraction?: boolean;
  onClick?: () => void;
}): boolean {
  if (!("Notification" in window) || Notification.permission !== "granted") return false;

  const notification = new Notification("AI Runtime", {
    body: options.body,
    tag: options.tag,
    requireInteraction: options.requireInteraction,
  });
  notification.onclick = () => {
    window.focus();
    options.onClick?.();
    notification.close();
  };
  return true;
}
