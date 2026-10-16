import { App as AntApp } from "antd";
import { useState } from "react";
import { api } from "../services/api";
import { errorText, type WorkItem } from "./model";

/** Browser history stays scoped to the authenticated account. */
export function useWorkbenchHistory(userId: string) {
  const { message, modal } = AntApp.useApp();
  const storageKey = `ai-runtime:workbench:${userId}`;
  const [saved, setSaved] = useState<WorkItem[]>(() => {
    try {
      const value: unknown = JSON.parse(localStorage.getItem(storageKey) || "[]");
      return Array.isArray(value) ? value.filter((item): item is WorkItem => Boolean(item && typeof item.id === "string" && typeof item.title === "string" && typeof item.conversationId === "string" && typeof item.projectId === "string" && ["manual", "tapd"].includes(item.source))) : [];
    } catch { return []; }
  });
  const [deletingConversation, setDeletingConversation] = useState<string>();
  const persist = (items: WorkItem[]) => {
    try { localStorage.setItem(storageKey, JSON.stringify(items)); setSaved(items); return true; }
    catch { message.error("任务保存失败，请检查浏览器存储空间"); return false; }
  };

  const deleteHistory = (item: WorkItem, onDeleted: () => void) => {
    if (deletingConversation) return;
    modal.confirm({
      title: "删除这段对话？", content: `“${item.title}”的聊天记录和当前任务工作区将被删除，未合并的改动也会清理。已合并的代码不受影响。`,
      okText: "删除", cancelText: "取消", okButtonProps: { danger: true },
      onOk: async () => {
        setDeletingConversation(item.conversationId);
        try {
          try { await api.deleteConversation(item.conversationId, item.projectId); }
          catch (error) { if (!(error instanceof Error) || error.message !== "任务不存在") throw error; }
          const sameConversation = (entry: { conversationId?: string; projectId: string }) => entry.conversationId === item.conversationId && entry.projectId === item.projectId;
          if (!persist(saved.filter(entry => !sameConversation(entry)))) throw new Error("本地记录清理失败，请重试删除");
          onDeleted(); message.success("对话已删除");
        } catch (error) { message.error(errorText(error)); }
        finally { setDeletingConversation(undefined); }
      },
    });
  };

  return { saved, persist, deleteHistory, deletingConversation };
}
