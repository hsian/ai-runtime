import { deleteRequirementTask, listRequirementTasks } from "../shared/requirementStore.js";
import type { RequirementTask } from "../shared/types.js";
import "./task-picker.css";

export interface CodingTaskPickerOptions {
  onSelect: (task: RequirementTask) => void;
}

let hideTimer: ReturnType<typeof setTimeout> | null = null;

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function summarize(text: string, max = 48): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

async function renderDropdown(dropdown: HTMLElement): Promise<void> {
  const tasks = await listRequirementTasks();
  if (tasks.length === 0) {
    dropdown.innerHTML = `<div class="task-picker-empty">暂无已保存的需求任务</div>`;
    return;
  }

  dropdown.innerHTML = tasks
    .map(
      (task) => `
        <div class="task-picker-item" data-task-id="${escapeHtml(task.id)}">
          <button class="task-picker-select" type="button" data-task-id="${escapeHtml(task.id)}">
            <span class="task-picker-title">${escapeHtml(task.title)}</span>
            <span class="task-picker-summary">${escapeHtml(summarize(task.draftPrompt))}</span>
          </button>
          <button class="task-picker-delete" type="button" data-delete-id="${escapeHtml(task.id)}" title="删除">×</button>
        </div>
      `
    )
    .join("");
}

export function initCodingTaskPicker(options: CodingTaskPickerOptions): void {
  const wrapper = document.getElementById("taskPickerWrap");
  const dropdown = document.getElementById("taskPickerDropdown");
  if (!wrapper || !dropdown) return;

  const show = (): void => {
    if (hideTimer) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
    void renderDropdown(dropdown);
    dropdown.hidden = false;
  };

  const scheduleHide = (): void => {
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      dropdown.hidden = true;
    }, 220);
  };

  wrapper.addEventListener("mouseenter", show);
  wrapper.addEventListener("mouseleave", scheduleHide);

  dropdown.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    const deleteId = target.closest<HTMLElement>("[data-delete-id]")?.dataset.deleteId;
    if (deleteId) {
      event.stopPropagation();
      void deleteRequirementTask(deleteId).then(() => renderDropdown(dropdown));
      return;
    }

    const taskId = target.closest<HTMLElement>("[data-task-id]")?.dataset.taskId;
    if (!taskId) return;

    void listRequirementTasks().then((tasks) => {
      const task = tasks.find((item) => item.id === taskId);
      if (task) {
        options.onSelect(task);
        dropdown.hidden = true;
      }
    });
  });
}
