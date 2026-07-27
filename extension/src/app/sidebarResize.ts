const DEFAULT_WIDTH = 255;
const MIN_WIDTH = 220;
const MAX_WIDTH = 480;
const MAX_WIDTH_RATIO = 0.45;
const STORAGE_KEY = "runtimeSidebarWidth";

function clampSidebarWidth(width: number): number {
  const viewportMaximum = Math.floor(window.innerWidth * MAX_WIDTH_RATIO);
  return Math.min(MAX_WIDTH, viewportMaximum, Math.max(MIN_WIDTH, width));
}

function applySidebarWidth(width: number): void {
  const nextWidth = clampSidebarWidth(width);
  document.querySelectorAll<HTMLElement>(".runtime-sidebar").forEach((sidebar) => {
    sidebar.style.width = `${nextWidth}px`;
    sidebar.style.flexBasis = `${nextWidth}px`;
  });
}

export function setupSidebarResize(): void {
  const resizers = document.querySelectorAll<HTMLElement>(".runtime-sidebar-resizer");
  if (resizers.length === 0) return;

  void chrome.storage.local.get([STORAGE_KEY]).then((stored) => {
    const savedWidth = stored[STORAGE_KEY];
    applySidebarWidth(typeof savedWidth === "number" ? savedWidth : DEFAULT_WIDTH);
  });

  resizers.forEach((resizer) => {
    resizer.addEventListener("mousedown", (event) => {
      event.preventDefault();
      const sidebar = resizer.closest<HTMLElement>(".runtime-sidebar");
      if (!sidebar) return;

      const startX = event.clientX;
      const startWidth = sidebar.offsetWidth;
      document.body.classList.add("sidebar-resizing");

      const onMove = (moveEvent: MouseEvent): void => {
        applySidebarWidth(startWidth + moveEvent.clientX - startX);
      };

      const onUp = (): void => {
        document.body.classList.remove("sidebar-resizing");
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        void chrome.storage.local.set({ [STORAGE_KEY]: sidebar.offsetWidth });
      };

      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
  });
}
